import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exitCodeFor, assertNodeSupported, describeStop, positiveIntOr, runAgent, runAgentCommand,
} from './agent.js';
import { MockProvider } from '../harness/model.js';
import { LocalExecutionWorld } from '../harness/world/local.js';
import type { ModelProvider } from '../harness/model.js';

/**
 * A provider whose generate() never resolves on its own — only when the
 * caller's signal aborts. Used to reach the real cancellation path through
 * runAgent: unlike a fixed delay racing a fixed wait, there is no upper-bound
 * timing assumption here, only a lower one (the simulated SIGINT must be
 * emitted after runAgent has registered its handler, which the test gives a
 * generous margin for).
 */
function abortAwareProvider(): ModelProvider {
  return {
    name: 'abort-aware',
    model: 'abort-aware',
    capabilities: () => Promise.resolve({ toolCalling: true, streaming: false, contextWindow: 200_000 }),
    generate: (_req, signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => resolve({ content: null, toolCalls: [] }), { once: true });
    }),
    countTokens: () => Promise.resolve(10),
  };
}

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

describe('positiveIntOr', () => {
  it('parses a valid value', () => {
    expect(positiveIntOr('45', 200, '--max-tool-calls')).toBe(45);
    expect(positiveIntOr(0, 200, '--timeout')).toBe(0);
    expect(positiveIntOr(undefined, 200, '--timeout')).toBe(200);
  });

  it('rejects a NaN value instead of silently disabling the budget', () => {
    // Number('oops') is NaN, and every >= comparison against NaN is false —
    // the exact defect this guard exists to close: a bad flag must fail
    // loudly, not run unbounded.
    expect(() => positiveIntOr('oops', 200, '--max-tool-calls'))
      .toThrow(/--max-tool-calls must be a non-negative number, got "oops"/);
  });

  it('rejects a negative value', () => {
    expect(() => positiveIntOr('-5', 200, '--timeout'))
      .toThrow(/--timeout must be a non-negative number, got "-5"/);
  });
});

describe('stop reasons', () => {
  it('distinguishes a blown budget from a user cancellation', () => {
    expect(describeStop('cancelled')).toBe('cancelled by user');
    expect(describeStop('max_turn_requests')).toBe('budget exhausted (max_turn_requests)');
    expect(describeStop('max_tokens')).toBe('budget exhausted (max_tokens)');
  });

  it('distinguishes a wall-clock deadline from the tool-call cap', () => {
    // Before this fix both Budget.check() cases returned 'max_turn_requests',
    // so a 15s --timeout run and a --max-tool-calls 0 run printed the
    // identical "budget exhausted (max_turn_requests)".
    expect(describeStop('deadline')).toBe('time limit reached');
    expect(describeStop('deadline')).not.toContain('max_turn_requests');
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

describe('startup failures', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reports an unusable provider without a stack trace', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write')
      .mockImplementation((s) => { errors.push(String(s)); return true; });
    try {
      // The bogus name goes in globalOpts (the third argument), which is what
      // createHarnessProvider actually reads — cmdOpts (the second argument)
      // has no `provider` field in the real command wiring in index.ts.
      const code = await runAgentCommand(
        'do a thing', {}, { provider: 'definitely-not-a-provider-xyz' }
      );
      expect(code).toBe(1);
      expect(errors.join('')).toContain('cannot start');
      expect(errors.join('')).not.toContain('at Object.'); // no stack frames
    } finally {
      spy.mockRestore();
    }
  });

  it('reports an unreadable --task-file without a stack trace', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write')
      .mockImplementation((s) => { errors.push(String(s)); return true; });
    try {
      const code = await runAgentCommand(undefined,
        { taskFile: '/definitely/not/a/real/path.md' }, {});
      expect(code).toBe(1);
      expect(errors.join('')).toContain('cannot start');
      expect(errors.join('')).not.toContain('at Object.');
    } finally {
      spy.mockRestore();
    }
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

    // A session that FINISHED (as opposed to one that was stopped) must print
    // exactly its terminal state — no cause line grafted onto it, and no
    // "session kept" hint, since a COMPLETED_VERIFIED run is not resumable
    // and should never look like one that is. Checking the exact line (not
    // just a substring) rules out an accidental `COMPLETED_VERIFIED — <something>`.
    const reportLines = written.split('\n');
    expect(reportLines).toContain('COMPLETED_VERIFIED');
    expect(written).not.toContain('kept; nothing was finalised');
  });

  it('reports a blown tool-call budget as budget exhaustion, not a user ' +
     'cancellation, and still exits 4', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // One scripted turn that calls a real, non-mutating, auto-allowed tool
    // (list_dir, risk R0) is enough: the loop counts the call, dispatches it,
    // then re-checks the budget at the top of its next iteration — with
    // maxToolCalls: 1 that check trips before a second model turn is ever
    // requested, so the script never needs to "keep calling tools" itself.
    const code = await runAgent({
      task: 'do the thing',
      cwd,
      provider: new MockProvider([
        { content: null, toolCalls: [{ id: '1', name: 'list_dir', arguments: { path: '.' } }] },
      ]),
      maxToolCalls: 1,
      dbPath: ':memory:',
    });

    // Per harness/loop.ts, a budget-exhausted turn writes no terminal event —
    // the same gap real cancellation leaves, because both must stay
    // resumable. exitCodeFor has no state for "budget exhausted" (only the
    // known TerminalState values), so runAgent's fallback still maps this to
    // CANCELLED's exit code, 4 — that part is unchanged and is not something
    // this fix touches.
    expect(code).toBe(4);

    const written = stdout.mock.calls.map((c) => String(c[0])).join('');
    // The behavior that actually matters: the human-readable report must say
    // *why* the run stopped, not just that it did — and the CANCELLED
    // placeholder must be fully replaced, not merely prefixed onto the cause,
    // since "CANCELLED — budget exhausted" would still tell the user someone
    // pressed Ctrl-C.
    expect(written).toContain('budget exhausted (max_turn_requests)');
    // Names the session id kept for later, not a --resume flag that does not
    // exist in index.ts.
    expect(written).toMatch(/Session .+ kept; nothing was finalised\./);
    expect(written).not.toContain('CANCELLED');
  });

  it('reports a genuine Ctrl-C as lowercase "cancelled by user", never the ' +
     'CANCELLED enum name, and still exits 4', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const runPromise = runAgent({
      task: 'do the thing',
      cwd,
      provider: abortAwareProvider(),
      dbPath: ':memory:',
    });

    // Give runAgent time to run loadRequirements (a real, if ENOENT, fs read)
    // and register its SIGINT handler before simulating the signal.
    // process.emit('SIGINT') invokes the same listener a real OS signal
    // would — no actual signal delivery needed, and no other test is left
    // holding a listener since runAgent removes its own in a `finally`.
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.emit('SIGINT');

    const code = await runPromise;
    expect(code).toBe(4);

    const written = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('cancelled by user');
    expect(written).not.toContain('CANCELLED');
  });

  it('creates a checkpoint and stamps its id onto file.modified when a ' +
     'mutating tool runs, in a real git repo (guarantee 5 wiring)', async () => {
    const world = new LocalExecutionWorld();
    const git = async (args: string[]): Promise<{ stdout: string; exitCode: number }> => {
      const r = await world.subprocess.run({ command: 'git', args, cwd, timeoutMs: 15_000 });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r;
    };

    await git(['init', '-q']);
    await git(['config', 'user.email', 't@example.com']);
    await git(['config', 'user.name', 'T']);
    await writeFile(join(cwd, 'a.txt'), 'original\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'init']);

    // A real git-generated unified diff rather than a hand-written one, so
    // the format is guaranteed valid. Restore the working tree afterward so
    // apply_patch — driven through the real runAgent/loop/dispatch stack, not
    // called directly — is what actually performs the mutation.
    await writeFile(join(cwd, 'a.txt'), 'modified\n');
    const diff = await git(['diff']);
    await git(['checkout', '--', 'a.txt']);
    expect(diff.stdout).toContain('a.txt');

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runAgent({
      task: 'do the thing',
      cwd,
      provider: new MockProvider([
        { content: null, toolCalls: [
          { id: '1', name: 'apply_patch', arguments: { patch: diff.stdout } },
        ] },
        { content: 'done', toolCalls: [] },
      ]),
      json: true,
      dbPath: ':memory:',
    });

    // COMPLETED_UNVERIFIED: nothing declared to verify. The exit code is
    // incidental here — what this test guards is guarantee 5 (spec 12: one
    // checkpoint per mutating batch), which had zero coverage: dropping
    // `checkpoints` from the deps object passed to runTurn in runAgent fails
    // no other test in this suite.
    expect(code).toBe(3);

    const lines = stdout.mock.calls.map((c) => String(c[0]).trim()).filter((l) => l !== '');
    const events = lines.map((l) => JSON.parse(l) as { event: Record<string, unknown> });

    const checkpointEvent = events.find((e) => e.event['type'] === 'checkpoint.created');
    const fileModifiedEvent = events.find((e) => e.event['type'] === 'file.modified');

    expect(checkpointEvent).toBeDefined();
    expect(fileModifiedEvent).toBeDefined();
    const checkpointId = (checkpointEvent?.event as { checkpointId?: string } | undefined)
      ?.checkpointId;
    expect(checkpointId).toBeTruthy();
    expect((fileModifiedEvent?.event as { checkpointId?: string } | undefined)?.checkpointId)
      .toBe(checkpointId);
  });

  it('reports how many checkpoints were kept when the run did not verify, ' +
     'instead of silently leaving permanent git refs behind', async () => {
    const world = new LocalExecutionWorld();
    const git = async (args: string[]): Promise<{ stdout: string; exitCode: number }> => {
      const r = await world.subprocess.run({ command: 'git', args, cwd, timeoutMs: 15_000 });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r;
    };

    await git(['init', '-q']);
    await git(['config', 'user.email', 't@example.com']);
    await git(['config', 'user.name', 'T']);
    await writeFile(join(cwd, 'a.txt'), 'original\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'init']);
    await writeFile(join(cwd, 'a.txt'), 'modified\n');
    const diff = await git(['diff']);
    await git(['checkout', '--', 'a.txt']);

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runAgent({
      task: 'do the thing',
      cwd,
      provider: new MockProvider([
        { content: null, toolCalls: [
          { id: '1', name: 'apply_patch', arguments: { patch: diff.stdout } },
        ] },
        { content: 'done', toolCalls: [] },
      ]),
      dbPath: ':memory:',
    });

    expect(code).toBe(3); // COMPLETED_UNVERIFIED: nothing declared to verify
    const written = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toMatch(/1 checkpoint kept under refs\/jam\/checkpoints\//);
  });

  it('prunes checkpoint refs after a COMPLETED_VERIFIED run, since nothing ' +
     'is left that could need rolling back', async () => {
    const world = new LocalExecutionWorld();
    const git = async (args: string[]): Promise<{ stdout: string; exitCode: number }> => {
      const r = await world.subprocess.run({ command: 'git', args, cwd, timeoutMs: 15_000 });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r;
    };

    await git(['init', '-q']);
    await git(['config', 'user.email', 't@example.com']);
    await git(['config', 'user.name', 'T']);
    await writeFile(join(cwd, 'a.txt'), 'original\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'init']);
    await writeFile(join(cwd, 'a.txt'), 'modified\n');
    const diff = await git(['diff']);
    await git(['checkout', '--', 'a.txt']);

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runAgent({
      task: 'do the thing',
      cwd,
      provider: new MockProvider([
        { content: null, toolCalls: [
          { id: '1', name: 'apply_patch', arguments: { patch: diff.stdout } },
        ] },
        { content: 'done', toolCalls: [] },
      ]),
      extraVerify: ['true'],
      json: true,
      dbPath: ':memory:',
    });

    expect(code).toBe(0); // COMPLETED_VERIFIED
    const lines = stdout.mock.calls.map((c) => String(c[0]).trim()).filter((l) => l !== '');
    const events = lines.map((l) => JSON.parse(l) as { event: Record<string, unknown> });
    const checkpointEvent = events.find((e) => e.event['type'] === 'checkpoint.created');
    const ref = (checkpointEvent?.event as { ref?: string } | undefined)?.ref;
    expect(ref).toBeTruthy();

    // The ref itself must be gone from git, not merely forgotten by an
    // in-memory store that is about to be discarded anyway.
    const check = await world.subprocess.run({
      command: 'git', args: ['show-ref', '--verify', '--quiet', ref as string],
      cwd, timeoutMs: 10_000,
    });
    expect(check.exitCode).not.toBe(0);
  });

  it('prints the changed-files list before the verdict, for every outcome ' +
     '-- not just buried below it', async () => {
    const world = new LocalExecutionWorld();
    const git = async (args: string[]): Promise<{ stdout: string; exitCode: number }> => {
      const r = await world.subprocess.run({ command: 'git', args, cwd, timeoutMs: 15_000 });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
      return r;
    };

    await git(['init', '-q']);
    await git(['config', 'user.email', 't@example.com']);
    await git(['config', 'user.name', 'T']);
    await writeFile(join(cwd, 'a.txt'), 'original\n');
    await git(['add', '.']);
    await git(['commit', '-qm', 'init']);
    await writeFile(join(cwd, 'a.txt'), 'modified\n');
    const diff = await git(['diff']);
    await git(['checkout', '--', 'a.txt']);

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runAgent({
      task: 'do the thing',
      cwd,
      provider: new MockProvider([
        { content: null, toolCalls: [
          { id: '1', name: 'apply_patch', arguments: { patch: diff.stdout } },
        ] },
        { content: 'done', toolCalls: [] },
      ]),
      extraVerify: ['true'],
      dbPath: ':memory:',
    });

    expect(code).toBe(0); // COMPLETED_VERIFIED
    const written = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(written).toContain('Changed:');
    expect(written).toContain('a.txt');
    expect(written).toContain('COMPLETED_VERIFIED');
    // Someone reading top-to-bottom must see what changed before the verdict,
    // not have to scroll past the verdict to find it.
    expect(written.indexOf('Changed:')).toBeLessThan(written.indexOf('COMPLETED_VERIFIED'));
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
