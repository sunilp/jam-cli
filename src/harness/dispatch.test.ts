import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { dispatch } from './dispatch.js';
import type { DispatchDeps } from './dispatch.js';
import { ToolRegistry } from './tools/registry.js';
import { DefaultPolicy } from './kernel/policy.js';
import { AutoApproveApprovalHost, AutoDenyApprovalHost } from './kernel/approval.js';
import { Journal } from './journal.js';
import { ArtifactStore } from './artifacts.js';
import { LocalExecutionWorld } from './world/local.js';
import { NullTelemetry } from './telemetry.js';
import type { Tool } from './tools/types.js';

let deps: DispatchDeps;
let journal: Journal;
let sessionId: string;
let executed: string[];

const okTool: Tool<{ a: string }, { echoed: string }> = {
  name: 'ok', description: 'echo', input: z.object({ a: z.string() }), risk: 'R0', mutates: false,
  execute: (i) => { executed.push('ok'); return Promise.resolve({ ok: true, value: { echoed: i.a } }); },
};

const riskyTool: Tool<Record<string, never>, null> = {
  name: 'risky', description: 'risky', input: z.object({}), risk: 'R3', mutates: false,
  execute: () => { executed.push('risky'); return Promise.resolve({ ok: true, value: null }); },
};

const forbiddenTool: Tool<Record<string, never>, null> = {
  name: 'forbidden', description: 'forbidden', input: z.object({}), risk: 'R4', mutates: false,
  execute: () => { executed.push('forbidden'); return Promise.resolve({ ok: true, value: null }); },
};

function makeDeps(approvals: DispatchDeps['approvals']): DispatchDeps {
  const registry = new ToolRegistry();
  registry.register(okTool);
  registry.register(riskyTool);
  registry.register(forbiddenTool);
  return {
    registry, policy: new DefaultPolicy(), approvals, journal,
    artifacts: new ArtifactStore(':memory:'), world: new LocalExecutionWorld(),
    telemetry: new NullTelemetry(), workspaceRoot: process.cwd(),
  };
}

beforeEach(() => {
  executed = [];
  journal = new Journal(':memory:');
  sessionId = journal.createSession({ task: 't', cwd: process.cwd(), requirements: [] });
  deps = makeDeps(new AutoApproveApprovalHost());
});

const types = (): string[] => journal.replay(sessionId).map((e) => e.event.type);

describe('dispatch', () => {
  it('records requested, decided and completed for an allowed call', async () => {
    await dispatch(deps, sessionId, { id: '1', name: 'ok', arguments: { a: 'hi' } },
      new AbortController().signal);
    expect(types()).toEqual(['session.created', 'tool.requested', 'tool.decided', 'tool.completed']);
    expect(executed).toEqual(['ok']);
  });

  it('rejects invalid input before the tool runs', async () => {
    await dispatch(deps, sessionId, { id: '1', name: 'ok', arguments: { a: 42 } },
      new AbortController().signal);
    expect(executed).toEqual([]);
    const done = journal.replay(sessionId).at(-1)!.event;
    expect(done).toMatchObject({ type: 'tool.completed', result: { errorType: 'invalid_input' } });
  });

  it('never executes a denied tool, and reports the denial to the model', async () => {
    await dispatch(deps, sessionId, { id: '1', name: 'forbidden', arguments: {} },
      new AbortController().signal);
    expect(executed).toEqual([]);
    const done = journal.replay(sessionId).at(-1)!.event;
    expect(done).toMatchObject({ type: 'tool.completed', result: { errorType: 'sandbox.denied' } });
  });

  it('denies an approval-required call when no approver is available', async () => {
    const d = makeDeps(new AutoDenyApprovalHost());
    await dispatch(d, sessionId, { id: '1', name: 'risky', arguments: {} },
      new AbortController().signal);
    expect(executed).toEqual([]);
    const decided = journal.replay(sessionId).find((e) => e.event.type === 'tool.decided')!;
    expect(decided.event).toMatchObject({ decision: { type: 'deny' } });
  });

  it('runs an approval-required call once approved', async () => {
    await dispatch(deps, sessionId, { id: '1', name: 'risky', arguments: {} },
      new AbortController().signal);
    expect(executed).toEqual(['risky']);
  });

  it('reports an unknown tool as not_found', async () => {
    await dispatch(deps, sessionId, { id: '1', name: 'nope', arguments: {} },
      new AbortController().signal);
    const done = journal.replay(sessionId).at(-1)!.event;
    expect(done).toMatchObject({ type: 'tool.completed', result: { errorType: 'not_found' } });
  });
});
