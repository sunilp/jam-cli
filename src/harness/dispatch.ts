import { riskOf } from './tools/types.js';
import { applyFailClosed } from './kernel/approval.js';
import { preview } from './artifacts.js';
import type { ToolRegistry } from './tools/registry.js';
import type { PolicyEngine, Provenance } from './kernel/policy.js';
import type { ApprovalHost } from './kernel/approval.js';
import type { Journal } from './journal.js';
import type { ArtifactStore } from './artifacts.js';
import type { ExecutionWorld } from './world/types.js';
import type { TelemetrySink } from './telemetry.js';
import type { ToolCall, ToolResultSummary, RuntimeEvent } from './events.js';
import type { StructuredError, ToolContext } from './tools/types.js';

export interface DispatchDeps {
  registry: ToolRegistry;
  policy: PolicyEngine;
  approvals: ApprovalHost;
  journal: Journal;
  artifacts: ArtifactStore;
  world: ExecutionWorld;
  telemetry: TelemetrySink;
  workspaceRoot: string;
}

function fail(callId: string, error: StructuredError, deps: DispatchDeps, sessionId: string,
              startedAt: number): void {
  const summary: ToolResultSummary = {
    ok: false, errorType: error.type, preview: error.message,
  };
  deps.journal.append(sessionId, {
    type: 'tool.completed', callId, result: summary, durationMs: Date.now() - startedAt,
  });
}

/**
 * The single path from a model-proposed action to a real effect.
 * Steps are numbered to match spec section 6.2.
 */
export async function dispatch(
  deps: DispatchDeps,
  sessionId: string,
  call: ToolCall,
  signal: AbortSignal,
  provenance: Provenance = 'model',
  /** Checkpoint covering this batch, created by the loop. '' when none. */
  checkpointId = ''
): Promise<void> {
  const startedAt = Date.now();
  const tool = deps.registry.get(call.name);
  if (!tool) {
    return fail(call.id, {
      type: 'not_found', recoverable: false, message: `Unknown tool: ${call.name}`,
    }, deps, sessionId, startedAt);
  }

  // (1) schema validation — model output is never trusted
  const parsed = tool.input.safeParse(call.arguments);
  if (!parsed.success) {
    return fail(call.id, {
      type: 'invalid_input', recoverable: true, message: parsed.error.message,
    }, deps, sessionId, startedAt);
  }
  const value = parsed.data;

  // (4) risk classification
  const risk = riskOf(tool, value);
  deps.journal.append(sessionId, {
    type: 'tool.requested', callId: call.id, tool: tool.name, input: value, risk,
  });

  // (5) policy evaluation, then (6) approval, fail-closed
  let decision = deps.policy.evaluate({
    tool: tool.name, input: value, risk, provenance, workspaceRoot: deps.workspaceRoot,
  });
  decision = applyFailClosed(decision, deps.approvals);

  if (decision.type === 'approval_required') {
    const granted = await deps.approvals.request({
      callId: call.id, tool: tool.name, risk, reason: decision.reason,
      summary: JSON.stringify(value).slice(0, 400),
    }, signal);

    // Journal the ORIGINAL approval_required decision, not a rewritten
    // 'allow'. Overwriting it destroys the fact that a human was asked and
    // said yes — the audit trail must be able to show human sign-off.
    deps.journal.append(sessionId, { type: 'tool.decided', callId: call.id, decision });
    if (!granted) {
      decision = { type: 'deny', reason: 'declined by user' };
      deps.journal.append(sessionId, { type: 'tool.decided', callId: call.id, decision });
    } else {
      decision = { type: 'allow' };
    }
  } else {
    deps.journal.append(sessionId, { type: 'tool.decided', callId: call.id, decision });
  }

  if (decision.type === 'deny') {
    // A refusal is information for the model, not an exception.
    return fail(call.id, {
      type: 'sandbox.denied', recoverable: false, message: decision.reason,
    }, deps, sessionId, startedAt);
  }

  // (8) execution through the world, (9) side effects observed via emit
  const emitted: RuntimeEvent[] = [];
  const ctx: ToolContext = {
    world: deps.world,
    workspaceRoot: deps.workspaceRoot,
    signal,
    emit: (e) => emitted.push(e),
    artifacts: deps.artifacts,
    callId: call.id,
  };

  let result;
  let threw: unknown;
  try {
    result = await tool.execute(value, ctx);
  } catch (err) {
    threw = err;
  }

  // Journal emitted events BEFORE handling a throw. A tool that emits
  // file.modified and then throws has still changed the workspace, and
  // dropping those events would leave an unlogged mutation.
  // Tools cannot know their checkpoint; the loop owns it, so stamp it here.
  for (const e of emitted) {
    deps.journal.append(
      sessionId,
      e.type === 'file.modified' ? { ...e, checkpointId } : e
    );
  }

  if (threw !== undefined || result === undefined) {
    return fail(call.id, {
      type: 'internal', recoverable: false,
      message: threw instanceof Error ? threw.message : String(threw),
    }, deps, sessionId, startedAt);
  }

  // (10) normalize, (13) durable event
  // Keep the full value retrievable even when the tool did not store one
  // itself: read_file, list_dir and search_text return potentially huge values
  // and have no artifact of their own.
  let summary: ToolResultSummary;
  if (result.ok) {
    const serialized = JSON.stringify(result.value);
    const artifact = result.artifact
      ?? (serialized.length > 8_000 ? deps.artifacts.put(serialized, 'application/json') : undefined);
    summary = { ok: true, preview: preview(serialized), artifactDigest: artifact?.digest };
  } else {
    summary = { ok: false, errorType: result.error.type,
                preview: preview(result.error.message) };
  }

  deps.journal.append(sessionId, {
    type: 'tool.completed', callId: call.id, result: summary,
    durationMs: Date.now() - startedAt,
  });
}
