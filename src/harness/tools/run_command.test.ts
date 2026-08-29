import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommandTool, classifyRisk } from './run_command.js';
import { LocalExecutionWorld } from '../world/local.js';
import { ArtifactStore } from '../artifacts.js';
import type { ToolContext } from './types.js';

let ctx: ToolContext;
beforeEach(async () => {
  ctx = {
    world: new LocalExecutionWorld(),
    workspaceRoot: await mkdtemp(join(tmpdir(), 'jam-run-')),
    signal: new AbortController().signal,
    emit: () => {},
    artifacts: new ArtifactStore(':memory:'),
    callId: 'c1',
  };
});

describe('classifyRisk', () => {
  it('treats inspection as R0', () => {
    expect(classifyRisk('git', ['status'])).toBe('R0');
    expect(classifyRisk('ls', ['-la'])).toBe('R0');
    expect(classifyRisk('rg', ['needle'])).toBe('R0');
  });

  it('treats workspace mutation as R1', () => {
    expect(classifyRisk('npm', ['test'])).toBe('R1');
    expect(classifyRisk('npm', ['install'])).toBe('R1');
  });

  it('treats network and process effects as R2', () => {
    expect(classifyRisk('curl', ['https://example.com'])).toBe('R2');
    expect(classifyRisk('docker', ['build', '.'])).toBe('R2');
  });

  it('treats destructive commands as R3', () => {
    expect(classifyRisk('rm', ['-rf', 'src'])).toBe('R3');
    expect(classifyRisk('git', ['reset', '--hard'])).toBe('R3');
  });

  it('treats production and privilege escalation as R4', () => {
    expect(classifyRisk('terraform', ['apply'])).toBe('R4');
    expect(classifyRisk('kubectl', ['delete', 'pod', 'x'])).toBe('R4');
    expect(classifyRisk('sudo', ['anything'])).toBe('R4');
  });

  it('defaults an unknown executable to R2 rather than allowing it', () => {
    expect(classifyRisk('some-unknown-binary', [])).toBe('R2');
  });

  it('does not auto-allow an interpreter given inline code', () => {
    expect(classifyRisk('node', ['-e', "require('fs').readFileSync('/etc/passwd')"])).toBe('R2');
    expect(classifyRisk('python3', ['-c', 'open("/etc/passwd").read()'])).toBe('R2');
    expect(classifyRisk('ruby', ['-e', 'puts 1'])).toBe('R2');
    expect(classifyRisk('node', ['scripts/build.js'])).toBe('R1');
    expect(classifyRisk('npm', ['test'])).toBe('R1');
  });
});

describe('run_command', () => {
  it('returns exit code and preview without throwing on failure', async () => {
    const r = await runCommandTool.execute(
      { command: 'node', args: ['-e', 'process.exit(2)'] }, ctx);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.exitCode).toBe(2);
  });

  it('stores full output as an artifact and only previews it to the model', async () => {
    const script = 'for (let i=0;i<5000;i++) console.log("line "+i)';
    const r = await runCommandTool.execute({ command: 'node', args: ['-e', script] }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.output).toContain('lines elided');
    expect(r.artifact).toBeDefined();
    expect(ctx.artifacts.get(r.artifact!.digest)).toContain('line 4999');
  });

  it('reports an unstartable binary as not_found, not a -1 exit code', async () => {
    const r = await runCommandTool.execute(
      { command: 'definitely-not-a-real-binary-xyz', args: [] }, ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.type).toBe('not_found');
  });

  it('reports cancellation rather than reporting it as command output', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 120);
    const r = await runCommandTool.execute(
      { command: 'node', args: ['-e', 'setTimeout(()=>{},60000)'] },
      { ...ctx, signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toMatch(/cancelled/i);
  });

  it('classifies destructive git subcommands above auto-allow', () => {
    expect(classifyRisk('git', ['checkout', '--', '.'])).toBe('R3');
    expect(classifyRisk('git', ['restore', '.'])).toBe('R3');
    expect(classifyRisk('git', ['rm', '-r', 'src'])).toBe('R3');
    expect(classifyRisk('git', ['filter-branch'])).toBe('R3');
    expect(classifyRisk('git', ['stash', 'drop'])).toBe('R3');
    expect(classifyRisk('git', ['stash', 'list'])).toBe('R0');
    expect(classifyRisk('git', ['status'])).toBe('R0');
    expect(classifyRisk('git', ['diff'])).toBe('R0');
  });

  it('reports a timeout as shell.timeout', async () => {
    const r = await runCommandTool.execute(
      { command: 'node', args: ['-e', 'setTimeout(()=>{},60000)'], timeoutMs: 300 }, ctx);
    expect(!r.ok && r.error.type).toBe('shell.timeout');
  });
});
