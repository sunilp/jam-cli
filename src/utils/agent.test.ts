import { describe, it, expect } from 'vitest';
import {
  parseExecutionPlan,
  formatExecutionPlanBlock,
  enrichUserPromptWithPlan,
  buildToolResultsSummary,
  StepVerifier,
  type ExecutionPlan,
  type PlanStep,
} from './agent.js';
import type { Message } from '../providers/base.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_PLAN: ExecutionPlan = {
  intent: 'Find where the provider factory creates adapters',
  steps: [
    {
      id: 1,
      action: 'Search for createProvider function',
      tool: 'search_text',
      args: { query: 'createProvider', glob: '*.ts' },
      successCriteria: 'Found function definition in factory.ts',
    },
    {
      id: 2,
      action: 'Read the factory file',
      tool: 'read_file',
      args: { path: 'src/providers/factory.ts' },
      successCriteria: 'Read the switch/case block for all providers',
    },
  ],
  minStepsBeforeAnswer: 2,
  expectedFiles: ['src/providers/factory.ts'],
};

// ── parseExecutionPlan ────────────────────────────────────────────────────────

describe('parseExecutionPlan', () => {
  it('parses a valid bare JSON string', () => {
    const json = JSON.stringify(VALID_PLAN);
    const result = parseExecutionPlan(json);
    expect(result).not.toBeNull();
    expect(result!.intent).toBe(VALID_PLAN.intent);
    expect(result!.steps).toHaveLength(2);
    expect(result!.minStepsBeforeAnswer).toBe(2);
    expect(result!.expectedFiles).toEqual(['src/providers/factory.ts']);
  });

  it('strips markdown code fences (```json ... ```)', () => {
    const wrapped = `\`\`\`json\n${JSON.stringify(VALID_PLAN)}\n\`\`\``;
    const result = parseExecutionPlan(wrapped);
    expect(result).not.toBeNull();
    expect(result!.steps).toHaveLength(2);
  });

  it('strips plain code fences (``` ... ```)', () => {
    const wrapped = `\`\`\`\n${JSON.stringify(VALID_PLAN)}\n\`\`\``;
    const result = parseExecutionPlan(wrapped);
    expect(result).not.toBeNull();
  });

  it('extracts JSON embedded in prose', () => {
    const prose = `Here is the plan:\n${JSON.stringify(VALID_PLAN)}\nHope that helps!`;
    const result = parseExecutionPlan(prose);
    expect(result).not.toBeNull();
    expect(result!.intent).toBe(VALID_PLAN.intent);
  });

  it('returns null for non-JSON text', () => {
    expect(parseExecutionPlan('This is not JSON at all.')).toBeNull();
  });

  it('returns null for JSON missing required fields', () => {
    const noIntent = { steps: VALID_PLAN.steps, minStepsBeforeAnswer: 2, expectedFiles: [] };
    expect(parseExecutionPlan(JSON.stringify(noIntent))).toBeNull();
  });

  it('returns null for empty steps array', () => {
    const emptySteps = { ...VALID_PLAN, steps: [] };
    expect(parseExecutionPlan(JSON.stringify(emptySteps))).toBeNull();
  });

  it('returns null when a step is missing successCriteria', () => {
    const badStep: Partial<PlanStep> = { id: 1, action: 'Search', tool: 'search_text', args: {} };
    const plan = { ...VALID_PLAN, steps: [badStep] };
    expect(parseExecutionPlan(JSON.stringify(plan))).toBeNull();
  });

  it('returns null for invalid JSON syntax', () => {
    expect(parseExecutionPlan('{ intent: oops, steps: [ }')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseExecutionPlan('')).toBeNull();
  });
});

// ── StepVerifier.parseVerifierResponse ───────────────────────────────────────

describe('StepVerifier.parseVerifierResponse', () => {
  const verifier = new StepVerifier();

  it('parses a ready-to-answer response', () => {
    const text = `STATUS: ready-to-answer\nSTEP: 0\nREASON: Found factory.ts with all cases.`;
    const result = verifier.parseVerifierResponse(text);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('ready-to-answer');
    expect(result!.nextStepId).toBe(0);
    expect(result!.reason).toBe('Found factory.ts with all cases.');
  });

  it('parses a need-more response', () => {
    const text = `STATUS: need-more\nSTEP: 2\nREASON: Found signature but not the body.`;
    const result = verifier.parseVerifierResponse(text);
    expect(result!.status).toBe('need-more');
    expect(result!.nextStepId).toBe(2);
  });

  it('parses a stuck response', () => {
    const text = `STATUS: stuck\nSTEP: 1\nREASON: All searches returned no results.`;
    const result = verifier.parseVerifierResponse(text);
    expect(result!.status).toBe('stuck');
    expect(result!.nextStepId).toBe(1);
    expect(result!.reason).toBe('All searches returned no results.');
  });

  it('is case-insensitive for STATUS keyword', () => {
    const text = `status: READY-TO-ANSWER\nstep: 0\nreason: Done.`;
    const result = verifier.parseVerifierResponse(text);
    expect(result!.status).toBe('ready-to-answer');
  });

  it('defaults to need-more for unknown status values', () => {
    const text = `STATUS: in-progress\nSTEP: 1\nREASON: working on it`;
    const result = verifier.parseVerifierResponse(text);
    expect(result!.status).toBe('need-more');
  });

  it('returns null for empty string', () => {
    expect(verifier.parseVerifierResponse('')).toBeNull();
  });

  it('returns null if STATUS line is missing', () => {
    expect(verifier.parseVerifierResponse('STEP: 1\nREASON: found something')).toBeNull();
  });

  it('handles missing STEP line gracefully (defaults to 0)', () => {
    const text = `STATUS: ready-to-answer\nREASON: Done.`;
    const result = verifier.parseVerifierResponse(text);
    expect(result!.nextStepId).toBe(0);
  });

  it('handles missing REASON line gracefully', () => {
    const text = `STATUS: need-more\nSTEP: 2`;
    const result = verifier.parseVerifierResponse(text);
    expect(result!.reason).toBe('No reason provided.');
  });
});

// ── enrichUserPromptWithPlan ──────────────────────────────────────────────────

describe('enrichUserPromptWithPlan', () => {
  it('includes the original prompt', () => {
    const prompt = 'How does the factory work?';
    const enriched = enrichUserPromptWithPlan(prompt, VALID_PLAN);
    expect(enriched).toContain(prompt);
  });

  it('includes the intent', () => {
    const enriched = enrichUserPromptWithPlan('q', VALID_PLAN);
    expect(enriched).toContain(VALID_PLAN.intent);
  });

  it('includes all step actions', () => {
    const enriched = enrichUserPromptWithPlan('q', VALID_PLAN);
    for (const step of VALID_PLAN.steps) {
      expect(enriched).toContain(step.action);
    }
  });

  it('includes success criteria for each step', () => {
    const enriched = enrichUserPromptWithPlan('q', VALID_PLAN);
    for (const step of VALID_PLAN.steps) {
      expect(enriched).toContain(step.successCriteria);
    }
  });

  it('includes the minStepsBeforeAnswer count', () => {
    const enriched = enrichUserPromptWithPlan('q', VALID_PLAN);
    expect(enriched).toContain(String(VALID_PLAN.minStepsBeforeAnswer));
  });

  it('includes expected files when present', () => {
    const enriched = enrichUserPromptWithPlan('q', VALID_PLAN);
    expect(enriched).toContain('src/providers/factory.ts');
  });

  it('omits expected files section when empty', () => {
    const plan = { ...VALID_PLAN, expectedFiles: [] };
    const enriched = enrichUserPromptWithPlan('q', plan);
    expect(enriched).not.toContain('Likely relevant files');
  });
});

// ── buildToolResultsSummary ───────────────────────────────────────────────────

describe('buildToolResultsSummary', () => {
  const makeToolMsg = (content: string): Message => ({
    role: 'user',
    content,
  });

  it('returns empty string when no tool messages', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    expect(buildToolResultsSummary(msgs)).toBe('');
  });

  it('includes content from [Tool result:] messages', () => {
    const msgs: Message[] = [
      makeToolMsg('[Tool result: search_text]\nsrc/providers/factory.ts:5: export function createProvider'),
    ];
    const summary = buildToolResultsSummary(msgs);
    expect(summary).toContain('Tool result');
    expect(summary).toContain('createProvider');
  });

  it('ignores non-tool user messages', () => {
    const msgs: Message[] = [
      makeToolMsg('What does this function do?'),
      makeToolMsg('[Tool result: read_file]\nline 1: import foo'),
    ];
    const summary = buildToolResultsSummary(msgs);
    expect(summary).not.toContain('What does this function');
    expect(summary).toContain('Tool result');
  });

  it('caps each result to 300 chars and appends ellipsis', () => {
    const longContent = '[Tool result: search_text]\n' + 'x'.repeat(500);
    const msgs: Message[] = [makeToolMsg(longContent)];
    const summary = buildToolResultsSummary(msgs);
    expect(summary).toContain('…');
    expect(summary.length).toBeLessThan(400);
  });

  it('only includes the last 6 tool results', () => {
    const msgs: Message[] = Array.from({ length: 10 }, (_, i) =>
      makeToolMsg(`[Tool result: search_text]\nresult ${i + 1}`),
    );
    const summary = buildToolResultsSummary(msgs);
    // Should contain results 5-10 (last 6), not result 1-4
    expect(summary).toContain('result 5');
    expect(summary).toContain('result 10');
    expect(summary).not.toContain('result 4');
  });
});

// ── formatExecutionPlanBlock ──────────────────────────────────────────────────

describe('formatExecutionPlanBlock', () => {
  it('includes the intent line', () => {
    const block = formatExecutionPlanBlock(VALID_PLAN, true);
    expect(block).toContain('Intent:');
    expect(block).toContain(VALID_PLAN.intent);
  });

  it('includes all step numbers and actions in noColor mode', () => {
    const block = formatExecutionPlanBlock(VALID_PLAN, true);
    expect(block).toContain('Step 1:');
    expect(block).toContain('Step 2:');
    expect(block).toContain(VALID_PLAN.steps[0]!.action);
  });

  it('includes minStepsBeforeAnswer', () => {
    const block = formatExecutionPlanBlock(VALID_PLAN, true);
    expect(block).toContain('Min steps before answering: 2');
  });

  it('includes expected files when non-empty', () => {
    const block = formatExecutionPlanBlock(VALID_PLAN, true);
    expect(block).toContain('src/providers/factory.ts');
  });

  it('omits expected files section when empty', () => {
    const plan = { ...VALID_PLAN, expectedFiles: [] };
    const block = formatExecutionPlanBlock(plan, true);
    expect(block).not.toContain('Expected files');
  });

  it('prefixes every line with │ in noColor mode', () => {
    const block = formatExecutionPlanBlock(VALID_PLAN, true);
    const lines = block.split('\n');
    expect(lines.every(l => l.startsWith('  │'))).toBe(true);
  });
});
