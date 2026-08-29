import type { TerminalState } from './events.js';

export type StopReason =
  | 'end_turn' | 'cancelled' | 'max_tokens' | 'max_turn_requests' | 'refusal';

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
    if (Date.now() >= this.limits.deadlineMs) return 'max_turn_requests';
    return null;
  }
}
