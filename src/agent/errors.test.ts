import { describe, it, expect } from 'vitest';
import { JamError } from '../utils/errors.js';

const AGENT_CODES = [
  'AGENT_PLAN_FAILED', 'AGENT_PLAN_CYCLE', 'AGENT_WORKER_TIMEOUT',
  'AGENT_WORKER_CANCELLED', 'AGENT_FILE_LOCK_CONFLICT', 'AGENT_FILE_LOCK_TIMEOUT',
  'AGENT_BUDGET_EXCEEDED', 'AGENT_SANDBOX_UNAVAILABLE', 'AGENT_RATE_LIMITED',
  'AGENT_MERGE_CONFLICT',
] as const;

describe('agent error codes', () => {
  for (const code of AGENT_CODES) {
    it(`creates JamError with code ${code}`, () => {
      const err = new JamError(`test ${code}`, code);
      expect(err.code).toBe(code);
      expect(err.hint).toBeDefined();
    });
  }
});
