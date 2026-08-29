import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn } from './loop.js';
import type { LoopDeps } from './loop.js';
import { Journal } from './journal.js';
import { ArtifactStore } from './artifacts.js';
import { ToolRegistry } from './tools/registry.js';
import { DefaultPolicy } from './kernel/policy.js';
import { AutoApproveApprovalHost } from './kernel/approval.js';
import { LocalExecutionWorld } from './world/local.js';
import { NullTelemetry } from './telemetry.js';
import { NaiveContext } from './context.js';
import { MockProvider } from './model.js';
import { Verifier } from './verify.js';
import type { Requirement } from './events.js';
import type { Tool } from './tools/types.js';

const world = new LocalExecutionWorld();
let root: string;
let journal: Journal;

const echo: Tool<{ a: string }, { echoed: string }> = {
  name: 'echo', description: 'echo', input: z.object({ a: z.string() }), risk: 'R0', mutates: false,
  execute: (i) => Promise.resolve({ ok: true, value: { echoed: i.a } }),
};

async function deps(script: ConstructorParameters<typeof MockProvider>[0],
                    requirements: Requirement[]): Promise<LoopDeps> {
  root = await mkdtemp(join(tmpdir(), 'jam-loop-'));
  journal = new Journal(':memory:');
  const artifacts = new ArtifactStore(':memory:');
  const registry = new ToolRegistry();
  registry.register(echo);
  return {
    journal, artifacts, registry, world,
    policy: new DefaultPolicy(),
    approvals: new AutoApproveApprovalHost(),
    telemetry: new NullTelemetry(),
    workspaceRoot: root,
    provider: new MockProvider(script),
    context: new NaiveContext(journal, registry),
    verifier: new Verifier(world, root, artifacts, requirements, 2),
    budget: { maxToolCalls: 50, maxTokens: 1_000_000, deadlineMs: Date.now() + 60_000 },
  };
}

const PASSING: Requirement[] = [{ command: 'node -e "process.exit(0)"', mustExit: 0 }];
const FAILING: Requirement[] = [{ command: 'node -e "process.exit(1)"', mustExit: 0 }];

beforeEach(() => { /* fresh per test via deps() */ });

describe('runTurn', () => {
  it('reaches COMPLETED_VERIFIED when declared requirements pass', async () => {
    const d = await deps([{ content: 'done', toolCalls: [] }], PASSING);
    const s = d.journal.createSession({ task: 't', cwd: root, requirements: PASSING });
    const stop = await runTurn(d, s, 't', new AbortController().signal);
    expect(stop).toBe('end_turn');
    expect(d.journal.replay(s).at(-1)!.event).toMatchObject({
      type: 'session.terminal', state: 'COMPLETED_VERIFIED',
    });
  });

  it('reaches COMPLETED_UNVERIFIED when nothing is declared', async () => {
    const d = await deps([{ content: 'done', toolCalls: [] }], []);
    const s = d.journal.createSession({ task: 't', cwd: root, requirements: [] });
    await runTurn(d, s, 't', new AbortController().signal);
    expect(d.journal.replay(s).at(-1)!.event).toMatchObject({
      type: 'session.terminal', state: 'COMPLETED_UNVERIFIED',
    });
  });

  it('does not let the model declare completion — failures are fed back', async () => {
    const d = await deps([
      { content: 'done', toolCalls: [] },
      { content: null, toolCalls: [{ id: '1', name: 'echo', arguments: { a: 'retry' } }] },
      { content: 'done again', toolCalls: [] },
    ], FAILING);
    const s = d.journal.createSession({ task: 't', cwd: root, requirements: FAILING });
    await runTurn(d, s, 't', new AbortController().signal);

    const types = d.journal.replay(s).map((e) => e.event.type);
    // Verification ran, the model was given another turn, and it ran a tool.
    expect(types.filter((t) => t === 'verification.completed').length).toBeGreaterThan(1);
    expect(types).toContain('tool.completed');
  });

  it('reaches COMPLETED_PARTIAL once the retry budget is spent', async () => {
    const d = await deps([
      { content: 'a', toolCalls: [] }, { content: 'b', toolCalls: [] },
      { content: 'c', toolCalls: [] }, { content: 'd', toolCalls: [] },
    ], FAILING);
    const s = d.journal.createSession({ task: 't', cwd: root, requirements: FAILING });
    await runTurn(d, s, 't', new AbortController().signal);
    expect(d.journal.replay(s).at(-1)!.event).toMatchObject({
      type: 'session.terminal', state: 'COMPLETED_PARTIAL',
    });
  });

  it('returns cancelled when the signal fires while the model is responding', async () => {
    const d = await deps([{ content: 'done', toolCalls: [] }], PASSING);
    const ac = new AbortController();
    d.provider = {
      name: 'aborting', model: 'stub',
      capabilities: () => Promise.resolve({ toolCalling: true, streaming: false, contextWindow: 1000 }),
      countTokens: () => Promise.resolve(1),
      generate: () => { ac.abort(); return Promise.resolve({ content: 'done', toolCalls: [] }); },
    };
    const s = d.journal.createSession({ task: 't', cwd: root, requirements: PASSING });

    expect(await runTurn(d, s, 't', ac.signal)).toBe('cancelled');
    expect(d.journal.replay(s).map((e) => e.event.type)).not.toContain('session.terminal');
  });

  it('records FAILED rather than rejecting when a dependency throws', async () => {
    const d = await deps([{ content: 'done', toolCalls: [] }], PASSING);
    d.context = { build: () => { throw new Error('context exploded'); } };
    const s = d.journal.createSession({ task: 't', cwd: root, requirements: PASSING });

    expect(await runTurn(d, s, 't', new AbortController().signal)).toBe('end_turn');
    expect(d.journal.replay(s).at(-1)!.event).toMatchObject({
      type: 'session.terminal', state: 'FAILED',
    });
  });

  it('cannot reach COMPLETED_VERIFIED by cancelling mid-verification', async () => {
    const two = [
      { command: 'node -e "process.exit(0)"', mustExit: 0 },
      { command: 'node -e "process.exit(0)"', mustExit: 0 },
    ];
    const d = await deps([{ content: 'done', toolCalls: [] }], two);
    const ac = new AbortController();
    const realEvaluate = d.verifier.evaluate.bind(d.verifier);
    d.verifier.evaluate = (round, signal) => { ac.abort(); return realEvaluate(round, signal); };
    const s = d.journal.createSession({ task: 't', cwd: root, requirements: two });

    const stop = await runTurn(d, s, 't', ac.signal);
    expect(stop).toBe('cancelled');
    const types = d.journal.replay(s).map((e) => e.event.type);
    expect(types).not.toContain('session.terminal');
  });

  it('returns cancelled on abort and leaves the session resumable', async () => {
    const d = await deps([{ content: 'done', toolCalls: [] }], PASSING);
    const s = d.journal.createSession({ task: 't', cwd: root, requirements: PASSING });
    const ac = new AbortController();
    ac.abort();
    expect(await runTurn(d, s, 't', ac.signal)).toBe('cancelled');
    const types = d.journal.replay(s).map((e) => e.event.type);
    expect(types).not.toContain('session.terminal');
  });

  it('stops with max_turn_requests when the tool budget is exhausted', async () => {
    const d = await deps(
      Array.from({ length: 10 }, () => ({
        content: null, toolCalls: [{ id: 'x', name: 'echo', arguments: { a: 'loop' } }],
      })), PASSING);
    d.budget.maxToolCalls = 2;
    const s = d.journal.createSession({ task: 't', cwd: root, requirements: PASSING });
    expect(await runTurn(d, s, 't', new AbortController().signal)).toBe('max_turn_requests');
  });

  it('stops with deadline, not max_turn_requests, once the wall clock runs out', async () => {
    // Same tool-call-budget shape as above, but the deadline is already past
    // rather than the call count. Before this fix Budget.check() returned
    // 'max_turn_requests' for both cases, so a wall-clock timeout was
    // indistinguishable from an exhausted tool-call cap.
    const d = await deps(
      Array.from({ length: 10 }, () => ({
        content: null, toolCalls: [{ id: 'x', name: 'echo', arguments: { a: 'loop' } }],
      })), PASSING);
    d.budget.deadlineMs = Date.now() - 1;
    const s = d.journal.createSession({ task: 't', cwd: root, requirements: PASSING });
    expect(await runTurn(d, s, 't', new AbortController().signal)).toBe('deadline');
  });

  it('ends FAILED when the provider fails unrecoverably', async () => {
    const d = await deps([], PASSING);
    const s = d.journal.createSession({ task: 't', cwd: root, requirements: PASSING });
    await runTurn(d, s, 't', new AbortController().signal);
    expect(d.journal.replay(s).at(-1)!.event).toMatchObject({
      type: 'session.terminal', state: 'FAILED',
    });
  });
});
