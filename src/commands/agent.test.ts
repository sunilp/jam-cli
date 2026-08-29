import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitCodeFor, assertNodeSupported, runAgent, runAgentCommand } from './agent.js';
import { MockProvider } from '../harness/model.js';

describe('assertNodeSupported', () => {
  it('accepts Node 22.5 and newer', () => {
    expect(() => assertNodeSupported('22.5.0')).not.toThrow();
    expect(() => assertNodeSupported('26.7.0')).not.toThrow();
  });

  it('rejects older runtimes with an actionable message', () => {
    expect(() => assertNodeSupported('20.19.0')).toThrow(/requires Node 22\.5/);
    expect(() => assertNodeSupported('22.4.0')).toThrow(/requires Node 22\.5/);
  });
});

describe('exitCodeFor', () => {
  it('maps terminal states to the documented exit codes', () => {
    expect(exitCodeFor('COMPLETED_VERIFIED')).toBe(0);
    expect(exitCodeFor('COMPLETED_PARTIAL')).toBe(1);
    expect(exitCodeFor('FAILED')).toBe(1);
    expect(exitCodeFor('COMPLETED_UNVERIFIED')).toBe(3);
    expect(exitCodeFor('CANCELLED')).toBe(4);
  });
});

describe('runAgentCommand', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('refuses to run with neither a task argument nor --task-file', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await runAgentCommand(undefined, {}, {});
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/task is required/));
  });

  it('refuses a blank --task-file without ever resolving a provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jam-agent-cmd-'));
    const taskFile = join(dir, 'task.txt');
    await writeFile(taskFile, '   \n');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // A blank task file must fail the same guard a missing task does, before
    // runAgentCommand ever imports the provider factory (which would reach
    // out to real config/credentials).
    const code = await runAgentCommand(undefined, { taskFile }, {});
    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/task is required/));
    await rm(dir, { recursive: true, force: true });
  });
});

describe('runAgent', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'jam-agent-run-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  it('reaches COMPLETED_VERIFIED and exits 0 when an extra verify command passes', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runAgent({
      task: 'do the thing',
      cwd,
      provider: new MockProvider([{ content: 'done', toolCalls: [] }]),
      extraVerify: ['true'],
      json: true,
      dbPath: ':memory:',
    });

    expect(code).toBe(0);
    const lines = stdout.mock.calls.map((c) => String(c[0]).trim()).filter((l) => l !== '');
    expect(lines.some((l) => l.includes('"type":"session.terminal"'))).toBe(true);
    expect(lines.some((l) => l.includes('COMPLETED_VERIFIED'))).toBe(true);

    // logicalClock must have been converted off its bigint before JSON.stringify
    // ever saw it, or every line here would have thrown TypeError instead of
    // producing output. Parse each event back and confirm the field survived
    // as a JSON-legal string rather than being silently dropped or coerced.
    for (const line of lines) {
      const parsed = JSON.parse(line) as { logicalClock: unknown };
      expect(typeof parsed.logicalClock).toBe('string');
      expect(parsed.logicalClock).toMatch(/^\d+$/);
    }
  });

  it('reaches COMPLETED_UNVERIFIED and exits 3 when nothing is declared to verify', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runAgent({
      task: 'do the thing',
      cwd,
      provider: new MockProvider([{ content: 'done', toolCalls: [] }]),
      json: true,
      dbPath: ':memory:',
    });

    expect(code).toBe(3);
    const written = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('COMPLETED_UNVERIFIED');
  });

  it('renders a human-readable report (non-JSON) with verification results', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runAgent({
      task: 'do the thing',
      cwd,
      provider: new MockProvider([{ content: 'done', toolCalls: [] }]),
      extraVerify: ['true'],
      dbPath: ':memory:',
    });

    expect(code).toBe(0);
    const written = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('Verification:');
    expect(written).toContain('✓ true');
    expect(written).toContain('COMPLETED_VERIFIED');
  });

  it('fails fast with a clear message when .jam/config.yaml is malformed, ' +
     'without opening a session', async () => {
    await mkdir(join(cwd, '.jam'), { recursive: true });
    await writeFile(
      join(cwd, '.jam', 'config.yaml'),
      'verification:\n  required: "not-a-list"\n'
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const code = await runAgent({
      task: 'do the thing',
      cwd,
      provider: new MockProvider([{ content: 'done', toolCalls: [] }]),
      dbPath: ':memory:',
    });

    expect(code).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringMatching(/verification\.required must be a list/)
    );
    // The malformed config is rejected before the provider is ever consulted,
    // so nothing about a session or a terminal state should be reported.
    expect(stdout).not.toHaveBeenCalled();
  });
});
