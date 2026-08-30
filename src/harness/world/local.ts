import { spawn, execFile } from 'node:child_process';
import { readFile, writeFile, readdir, stat, realpath, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ExecutionWorld, FileSystem, SubprocessRuntime, TerminalRuntime,
  ProcRequest, ProcResult, DirEntry,
} from './types.js';

const isWindows = process.platform === 'win32';

// cmd.exe metacharacters that need ^-escaping so they stay literal instead
// of being reinterpreted as shell syntax (redirection, piping, chaining...).
// See http://www.robvanderwoude.com/escapechars.php
const CMD_META_CHARS = /([()%!^"`<>&|;, *?])/g;

function escapeCmdMetaChars(s: string): string {
  return s.replace(CMD_META_CHARS, '^$1');
}

/**
 * Quotes one argument for cmd.exe's command-line parser: doubles backslashes
 * that immediately precede a quote (or end the string, since a trailing
 * backslash would otherwise escape the closing quote this adds), wraps the
 * result in quotes, then escapes cmd.exe metacharacters — including the
 * quotes just added, which is intentional and specific to invoking through
 * `cmd /c "..."`. Algorithm: https://qntm.org/cmd, as implemented by
 * cross-spawn (github.com/moxystudio/node-cross-spawn, MIT,
 * lib/util/escape.js) — reproduced here rather than adding a dependency for
 * one function.
 */
function escapeCmdArgument(arg: string): string {
  const quoted = `"${arg
    .replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
    .replace(/(?=(\\+?)?)\1$/, '$1$1')}"`;
  return escapeCmdMetaChars(quoted);
}

/**
 * On Windows, CreateProcess cannot directly launch a `.cmd`/`.bat` file (or
 * anything resolved only via PATHEXT) — `spawn('npm', ...)` throws EINVAL
 * for exactly this since Node's CVE-2024-27980 fix, and most of what
 * run_command.ts's R1 set names (npm, npx, tsc, vitest, eslint, prettier,
 * pnpm, yarn) are `.cmd` shims on Windows, not `.exe` binaries. Routing
 * everything through `cmd.exe /d /s /c` sidesteps needing to know in
 * advance which target is which: cmd.exe resolves PATH/PATHEXT exactly the
 * way a user typing the command would.
 *
 * Node's own `shell: true` does the same `/d /s /c` wrapping, but naively
 * string-joins the argument array with NO escaping — unsafe here, since
 * `args` can carry agent- or model-supplied content (run_command.ts's input
 * schema explicitly promises "Not a shell string"). Escaping every argument
 * ourselves and setting windowsVerbatimArguments preserves argv-array
 * semantics instead: an argument is never reinterpreted as shell syntax.
 */
export function windowsShellInvocation(command: string, args: string[]): { file: string; args: string[] } {
  const line = [escapeCmdMetaChars(command), ...args.map(escapeCmdArgument)].join(' ');
  return {
    file: process.env['ComSpec'] || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
  };
}

const localFs: FileSystem = {
  readFile: (p) => readFile(p, 'utf-8'),
  writeFile: (p, c) => writeFile(p, c, 'utf-8'),
  async list(p): Promise<DirEntry[]> {
    const entries = await readdir(p, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      kind: e.isFile() ? 'file' : e.isDirectory() ? 'dir' : 'other',
    }));
  },
  async stat(p) {
    try {
      const s = await stat(p);
      return { size: s.size, isFile: s.isFile(), isDir: s.isDirectory() };
    } catch { return undefined; }
  },
  realpath: (p) => realpath(p),
  mkdtemp: (prefix) => mkdtemp(join(tmpdir(), prefix)),
};

const localSubprocess: SubprocessRuntime = {
  run(req: ProcRequest): Promise<ProcResult> {
    return new Promise<ProcResult>((resolve) => {
      const startedAt = Date.now();

      // addEventListener('abort') never fires on an already-aborted signal, so
      // without this an aborted caller waits out the FULL timeout (minutes for
      // a verification command) and is told aborted: false. Never spawn.
      if (req.signal?.aborted === true) {
        resolve({
          exitCode: -1, stdout: '', stderr: '', timedOut: false,
          aborted: true, spawnFailed: false, durationMs: 0,
        });
        return;
      }

      const { file, args } = isWindows
        ? windowsShellInvocation(req.command, req.args)
        : { file: req.command, args: req.args };

      // detached puts the child in its own POSIX process group so we can
      // signal the whole tree with a single negative-PID kill. Without this
      // a cancelled `npm test` orphans its runner. Windows has no such
      // concept — detached there only affects console ownership, not
      // killability — so killTree below uses `taskkill /T` instead, which
      // walks the OS process tree by PID and doesn't need this.
      const child = spawn(file, args, {
        cwd: req.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWindows,
        windowsVerbatimArguments: isWindows,
        windowsHide: isWindows,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const killTree = (): void => {
        if (child.pid === undefined) return;
        if (isWindows) {
          // process.kill(-pid) is POSIX-only (negative PID targets a process
          // group, which Windows doesn't have). Commands also now run one
          // level down inside cmd.exe, so killing only that PID would leave
          // whatever it launched running — `/T` walks the whole tree by PID
          // instead, independent of any process-group concept.
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {
            /* best effort: the child may have already exited on its own */
          });
          return;
        }
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      };

      child.stdout.on('data', (c: Buffer) => {
        const s = c.toString('utf8');
        stdout += s;
        req.telemetry?.write({ kind: 'proc.stdout', callId: req.callId ?? '', chunk: s });
      });
      child.stderr.on('data', (c: Buffer) => {
        const s = c.toString('utf8');
        stderr += s;
        req.telemetry?.write({ kind: 'proc.stderr', callId: req.callId ?? '', chunk: s });
      });

      const timer = setTimeout(() => { timedOut = true; killTree(); }, req.timeoutMs);
      const onAbort = (): void => { aborted = true; killTree(); };
      req.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = (exitCode: number, spawnFailed = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', onAbort);
        resolve({
          exitCode, stdout, stderr, timedOut, aborted, spawnFailed,
          durationMs: Date.now() - startedAt,
        });
      };

      child.on('error', () => finish(-1, true));
      child.on('close', (code) => finish(code ?? -1));
    });
  },
};

const localTerminal: TerminalRuntime = { supportsPty: () => false };

export class LocalExecutionWorld implements ExecutionWorld {
  readonly fs = localFs;
  readonly subprocess = localSubprocess;
  readonly terminal = localTerminal;
}
