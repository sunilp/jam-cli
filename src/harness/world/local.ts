import { spawn } from 'node:child_process';
import { readFile, writeFile, readdir, stat, realpath, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ExecutionWorld, FileSystem, SubprocessRuntime, TerminalRuntime,
  ProcRequest, ProcResult, DirEntry,
} from './types.js';

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

      // detached puts the child in its own process group so we can signal the
      // whole tree. Without this a cancelled `npm test` orphans its runner.
      const child = spawn(req.command, req.args, {
        cwd: req.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let aborted = false;
      let settled = false;

      const killTree = (): void => {
        if (child.pid === undefined) return;
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
