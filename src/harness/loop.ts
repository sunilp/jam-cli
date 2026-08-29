import { dispatch } from './dispatch.js';
import { Budget } from './session.js';
import type { StopReason } from './session.js';
import type { DispatchDeps } from './dispatch.js';
import type { ContextProvider } from './context.js';
import type { ModelProvider } from './model.js';
import type { Verifier } from './verify.js';
import type { BudgetLimits } from './session.js';
import type { TerminalState } from './events.js';
import type { CheckpointStore } from './checkpoint.js';

export interface LoopDeps extends DispatchDeps {
  provider: ModelProvider;
  context: ContextProvider;
  verifier: Verifier;
  budget: BudgetLimits;
  /** Optional: without it the run is simply not reversible. */
  checkpoints?: CheckpointStore;
}

function finish(deps: LoopDeps, sessionId: string, state: TerminalState): void {
  deps.journal.append(sessionId, { type: 'session.terminal', state });
  deps.journal.setState(sessionId, state);
}

export async function runTurn(
  deps: LoopDeps,
  sessionId: string,
  prompt: string,
  signal: AbortSignal
): Promise<StopReason> {
  try {
    return await turn(deps, sessionId, prompt, signal);
  } catch (err) {
    // Nothing may escape as a rejected promise. Only provider.generate() was
    // guarded before, so a throw from context.build, verifier.evaluate,
    // journal.append or dispatch left the caller with neither a terminal event
    // nor a StopReason — an unhandled rejection instead of a recorded outcome.
    if (signal.aborted) return 'cancelled';
    deps.journal.append(sessionId, {
      type: 'model.failed',
      error: {
        type: 'internal', recoverable: false,
        message: err instanceof Error ? err.message : String(err),
      },
    });
    finish(deps, sessionId, 'FAILED');
    return 'end_turn';
  }
}

async function turn(
  deps: LoopDeps,
  sessionId: string,
  prompt: string,
  signal: AbortSignal
): Promise<StopReason> {
  if (signal.aborted) return 'cancelled';

  const budget = new Budget(deps.budget);
  let round = 0;

  for (;;) {
    if (signal.aborted) return 'cancelled';
    const over = budget.check();
    if (over !== null) return over;

    const request = deps.context.build(sessionId);
    deps.journal.append(sessionId, {
      type: 'model.requested',
      provider: deps.provider.name,
      model: deps.provider.model,
      inputTokens: await deps.provider.countTokens(request),
    });

    let res;
    try {
      res = await deps.provider.generate(request, signal);
    } catch (err) {
      if (signal.aborted) return 'cancelled';
      deps.journal.append(sessionId, {
        type: 'model.failed',
        error: {
          type: 'internal', recoverable: false,
          message: err instanceof Error ? err.message : String(err),
        },
      });
      finish(deps, sessionId, 'FAILED');
      return 'end_turn';
    }

    // The signal can fire WHILE generate() is in flight. Without this check the
    // turn proceeds to verify and writes a terminal event for a cancelled
    // session, which must stay resumable.
    if (signal.aborted) return 'cancelled';

    if (res.unrecoverable === true) {
      deps.journal.append(sessionId, {
        type: 'model.failed',
        error: { type: 'internal', recoverable: false, message: 'provider exhausted' },
      });
      finish(deps, sessionId, 'FAILED');
      return 'end_turn';
    }

    deps.journal.append(sessionId, {
      type: 'model.completed',
      content: res.content,
      toolCalls: res.toolCalls,
      usage: res.usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    budget.countTokens(res.usage?.totalTokens ?? 0);

    if (res.toolCalls.length === 0) {
      // The model wants to stop. It does not get to decide that.
      const verdict = await deps.verifier.evaluate(round, signal);
      // A cancelled session gets no terminal state at all. Belt to the
      // verifier's braces: never record an outcome for work that was stopped.
      if (signal.aborted) return 'cancelled';
      deps.journal.append(sessionId, {
        type: 'verification.completed', results: verdict.results,
      });

      if (!verdict.runnable) { finish(deps, sessionId, 'COMPLETED_UNVERIFIED'); return 'end_turn'; }
      if (verdict.satisfied) { finish(deps, sessionId, 'COMPLETED_VERIFIED');   return 'end_turn'; }
      if (verdict.exhausted) { finish(deps, sessionId, 'COMPLETED_PARTIAL');    return 'end_turn'; }

      round += 1;
      continue; // failures are now in the context; the model gets another turn
    }

    // One checkpoint per mutating batch, so every edit is reversible (spec 12).
    let checkpointId = '';
    const mutating = res.toolCalls.some((c) => deps.registry.get(c.name)?.mutates === true);
    if (mutating && deps.checkpoints !== undefined) {
      try {
        const cp = await deps.checkpoints.create(`turn ${round}`);
        checkpointId = cp.id;
        deps.journal.append(sessionId, {
          type: 'checkpoint.created', checkpointId: cp.id, ref: cp.ref,
        });
      } catch {
        // A repo without git still runs; it just cannot roll back.
      }
    }

    for (const call of res.toolCalls) {
      if (signal.aborted) return 'cancelled';
      budget.countToolCall();
      await dispatch(deps, sessionId, call, signal, 'model', checkpointId);
    }
  }
}
