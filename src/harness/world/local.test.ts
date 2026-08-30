import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalExecutionWorld, windowsShellInvocation } from './local.js';

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jam-world-'));
  await writeFile(join(dir, 'a.txt'), 'alpha\n');
  return dir;
}

describe('LocalExecutionWorld.fs', () => {
  it('reads a file', async () => {
    const dir = await fixture();
    const w = new LocalExecutionWorld();
    expect(await w.fs.readFile(join(dir, 'a.txt'))).toBe('alpha\n');
  });

  it('lists a directory', async () => {
    const dir = await fixture();
    const w = new LocalExecutionWorld();
    expect(await w.fs.list(dir)).toContainEqual({ name: 'a.txt', kind: 'file' });
  });
});

describe('LocalExecutionWorld.subprocess', () => {
  it('captures stdout and exit code', async () => {
    const w = new LocalExecutionWorld();
    const r = await w.subprocess.run({
      command: 'node', args: ['-e', 'console.log("hi")'],
      cwd: process.cwd(), timeoutMs: 10_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hi');
    expect(r.timedOut).toBe(false);
  });

  it('reports a non-zero exit rather than throwing', async () => {
    const w = new LocalExecutionWorld();
    const r = await w.subprocess.run({
      command: 'node', args: ['-e', 'process.exit(3)'],
      cwd: process.cwd(), timeoutMs: 10_000,
    });
    expect(r.exitCode).toBe(3);
  });

  it('times out and reports it', async () => {
    const w = new LocalExecutionWorld();
    const r = await w.subprocess.run({
      command: 'node', args: ['-e', 'setTimeout(()=>{},60000)'],
      cwd: process.cwd(), timeoutMs: 300,
    });
    expect(r.timedOut).toBe(true);
  });

  it('kills the whole process group, not just the direct child', async () => {
    const w = new LocalExecutionWorld();
    // Parent spawns a long-lived grandchild then exits its own event loop.
    const script =
      'const {spawn}=require("child_process");' +
      'const c=spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"ignore"});' +
      'console.log(c.pid); setTimeout(()=>{},60000);';
    const r = await w.subprocess.run({
      command: 'node', args: ['-e', script], cwd: process.cwd(), timeoutMs: 500,
    });
    const grandchild = Number(r.stdout.trim());
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 200));
    // process.kill(pid, 0) throws ESRCH when the pid is gone.
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it('aborts on signal and actually kills the process', async () => {
    const w = new LocalExecutionWorld();
    const ac = new AbortController();
    const script = 'console.log(process.pid); setTimeout(()=>{},60000);';
    setTimeout(() => ac.abort(), 150);
    const r = await w.subprocess.run({
      command: 'node', args: ['-e', script],
      cwd: process.cwd(), timeoutMs: 30_000, signal: ac.signal,
    });
    expect(r.aborted).toBe(true);
    const pid = Number(r.stdout.trim());
    await new Promise((res) => setTimeout(res, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('returns immediately for a signal aborted before the call', async () => {
    const w = new LocalExecutionWorld();
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const r = await w.subprocess.run({
      command: 'node', args: ['-e', 'setTimeout(()=>{},60000)'],
      cwd: process.cwd(), timeoutMs: 5_000, signal: ac.signal,
    });
    expect(r.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  // These run on every platform — they test pure string construction, not
  // an actual spawn — because the real Windows spawn path (cmd.exe
  // resolving npm.cmd, taskkill killing the tree) cannot be exercised on
  // this machine at all. The expected strings were computed by running
  // windowsShellInvocation directly and reading its output, then fixed here
  // as a regression pin; they were not independently verified against a
  // real cmd.exe. The algorithm itself is cross-spawn's documented one
  // (github.com/moxystudio/node-cross-spawn, MIT, lib/util/escape.js +
  // lib/parse.js's parseNonShell), reproduced in local.ts rather than
  // pulled in as a dependency.
  describe('windowsShellInvocation', () => {
    it('always routes through cmd.exe /d /s /c with windowsVerbatimArguments in mind', () => {
      const r = windowsShellInvocation('npm', ['test']);
      expect(r.file).toBe('cmd.exe');
      expect(r.args[0]).toBe('/d');
      expect(r.args[1]).toBe('/s');
      expect(r.args[2]).toBe('/c');
      expect(r.args).toHaveLength(4);
    });

    it('quotes each argument and caret-escapes cmd.exe metacharacters', () => {
      expect(windowsShellInvocation('npm', ['run', 'test']).args[3])
        .toBe('"npm ^"run^" ^"test^""');
    });

    it('neutralises a shell-chaining metacharacter instead of executing it as a second command', () => {
      // Without escaping, `a&b` passed through a naive shell join would run
      // `a` then separately run `b` — this is exactly the command-injection
      // shape jam's run_command tool exists to prevent even on POSIX, where
      // args are never shell-interpreted in the first place.
      expect(windowsShellInvocation('echo', ['a&b']).args[3])
        .toBe('"echo ^"a^&b^""');
      expect(windowsShellInvocation('echo', ['a|b>c']).args[3])
        .toBe('"echo ^"a^|b^>c^""');
    });

    it('escapes an embedded double quote without breaking argument boundaries', () => {
      expect(windowsShellInvocation('echo', ['a"b']).args[3])
        .toBe('"echo ^"a\\^"b^""');
    });

    it('doubles a trailing backslash so it cannot escape the closing quote', () => {
      expect(windowsShellInvocation('echo', ['trailing\\']).args[3])
        .toBe('"echo ^"trailing\\\\^""');
    });

    it('round-trips a realistic multi-flag command', () => {
      expect(windowsShellInvocation('git', ['commit', '-m', 'fix: handle "quotes" & stuff']).args[3])
        .toBe('"git ^"commit^" ^"-m^" ^"fix:^ handle^ \\^"quotes\\^"^ ^&^ stuff^""');
    });
  });

  it('distinguishes a spawn failure from a killed process', async () => {
    const w = new LocalExecutionWorld();
    const missing = await w.subprocess.run({
      command: 'definitely-not-a-real-binary-xyz', args: [],
      cwd: process.cwd(), timeoutMs: 10_000,
    });
    expect(missing.spawnFailed).toBe(true);

    const killed = await w.subprocess.run({
      command: 'node', args: ['-e', 'setTimeout(()=>{},60000)'],
      cwd: process.cwd(), timeoutMs: 300,
    });
    expect(killed.exitCode).toBe(-1);
    expect(killed.spawnFailed).toBe(false);
    expect(killed.timedOut).toBe(true);
  });
});
