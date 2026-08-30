import type { TerminalState } from './events.js';

export type StopReason =
  | 'end_turn' | 'cancelled' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'deadline';

export type SessionState =
  | 'created' | 'running' | 'waiting_approval' | 'waiting_user' | 'verifying' | TerminalState;

export interface BudgetLimits {
  maxToolCalls: number;
  maxTokens: number;
  deadlineMs: number;
}

export class Budget {
  private toolCalls = 0;
  private tokens = 0;

  constructor(private readonly limits: BudgetLimits) {}

  countToolCall(): void { this.toolCalls += 1; }
  countTokens(n: number): void { this.tokens += n; }

  /** Returns the StopReason that applies, or null if there is room left. */
  check(): StopReason | null {
    if (this.toolCalls >= this.limits.maxToolCalls) return 'max_turn_requests';
    if (this.tokens >= this.limits.maxTokens) return 'max_tokens';
    // Distinct from 'max_turn_requests': a 15s-deadline run and a
    // --max-tool-calls 0 run used to both report 'max_turn_requests', so the
    // human-readable report printed the identical "budget exhausted
    // (max_turn_requests)" for a wall-clock timeout and a tool-call cap.
    if (Date.now() >= this.limits.deadlineMs) return 'deadline';
    return null;
  }
}
