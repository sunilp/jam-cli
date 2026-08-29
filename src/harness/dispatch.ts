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
    if (!granted) decision = { type: 'deny', reason: 'declined by user' };
    else decision = { type: 'allow' };
  }

  deps.journal.append(sessionId, { type: 'tool.decided', callId: call.id, decision });

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
  try {
    result = await tool.execute(value, ctx);
  } catch (err) {
    return fail(call.id, {
      type: 'internal', recoverable: false,
      message: err instanceof Error ? err.message : String(err),
    }, deps, sessionId, startedAt);
  }

  // Tools cannot know their checkpoint; the loop owns it, so stamp it here.
  for (const e of emitted) {
    deps.journal.append(
      sessionId,
      e.type === 'file.modified' ? { ...e, checkpointId } : e
    );
  }

  // (10) normalize, (13) durable event
  const summary: ToolResultSummary = result.ok
    ? {
        ok: true,
        preview: preview(JSON.stringify(result.value)),
        artifactDigest: result.artifact?.digest,
      }
    : { ok: false, errorType: result.error.type, preview: result.error.message };

  deps.journal.append(sessionId, {
    type: 'tool.completed', callId: call.id, result: summary,
    durationMs: Date.now() - startedAt,
  });
}
