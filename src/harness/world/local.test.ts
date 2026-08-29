import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalExecutionWorld } from './local.js';

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

  it('aborts on signal', async () => {
    const w = new LocalExecutionWorld();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await w.subprocess.run({
      command: 'node', args: ['-e', 'setTimeout(()=>{},60000)'],
      cwd: process.cwd(), timeoutMs: 30_000, signal: ac.signal,
    });
    expect(r.aborted).toBe(true);
  });
});
