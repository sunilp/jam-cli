import { describe, it, expect } from 'vitest';
import { Budget } from './session.js';

describe('Budget', () => {
  it('reports no limit reached while under every ceiling', () => {
    const b = new Budget({ maxToolCalls: 5, maxTokens: 1000, deadlineMs: Date.now() + 60_000 });
    expect(b.check()).toBeNull();
  });

  it('reports max_turn_requests once the tool-call cap is reached', () => {
    const b = new Budget({ maxToolCalls: 1, maxTokens: 1000, deadlineMs: Date.now() + 60_000 });
    b.countToolCall();
    expect(b.check()).toBe('max_turn_requests');
  });

  it('reports max_tokens once the token cap is reached', () => {
    const b = new Budget({ maxToolCalls: 5, maxTokens: 10, deadlineMs: Date.now() + 60_000 });
    b.countTokens(10);
    expect(b.check()).toBe('max_tokens');
  });

  // Distinct from max_turn_requests: before this fix, a wall-clock timeout and
  // an exhausted tool-call cap were indistinguishable to a caller, so a
  // 15s-deadline run and a --max-tool-calls 0 run both printed the identical
  // "budget exhausted (max_turn_requests)".
  it('reports deadline, not max_turn_requests, once the wall-clock deadline passes', () => {
    const b = new Budget({ maxToolCalls: 5, maxTokens: 1000, deadlineMs: Date.now() - 1 });
    expect(b.check()).toBe('deadline');
  });
});
