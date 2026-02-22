/**
 * Critic agent — evaluates the main agent's answer for quality and relevance.
 *
 * Replaces the naive keyword-matching `checkAnswerRelevance` with a real
 * LLM-based evaluation.  The critic runs as a separate, cheap LLM call
 * with a focused system prompt.
 */

import type { ProviderAdapter } from '../providers/base.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CriticVerdict {
  /** Whether the answer passes quality checks. */
  pass: boolean;
  /** Brief reason if it fails. */
  reason: string;
  /** Confidence 0-1 (from the critic's self-assessment). */
  confidence: number;
}

// ── Critic prompt ─────────────────────────────────────────────────────────────

const CRITIC_SYSTEM_PROMPT = `You are a strict answer quality evaluator for a code assistant.

You will receive:
1. The user's ORIGINAL QUESTION
2. The assistant's PROPOSED ANSWER

Evaluate the answer on these criteria:
- RELEVANCE: Does the answer address the user's specific question?
- SPECIFICITY: Does the answer reference specific files, line numbers, or code?
- ACCURACY: Does the answer appear technically correct (no obvious hallucinations)?
- COMPLETENESS: Does the answer cover the main aspects of the question?
- FORMAT: Is the answer in clean Markdown (not raw JSON, not gibberish)?

Respond in EXACTLY this format (no extra text):
PASS or FAIL
CONFIDENCE: 0.0-1.0
REASON: one sentence explanation

Examples:
PASS
CONFIDENCE: 0.9
REASON: Answer correctly identifies the provider factory pattern in src/providers/factory.ts with specific line references.

FAIL
CONFIDENCE: 0.8
REASON: Answer describes the context.ts file but the user asked about LLM providers — completely off-topic.`;

// ── Critic execution ──────────────────────────────────────────────────────────

/**
 * Run the critic agent to evaluate an answer.
 *
 * Uses a low temperature and short max tokens for fast, focused evaluation.
 * Falls back to PASS if the critic call fails (non-blocking).
 */
export async function criticEvaluate(
  provider: ProviderAdapter,
  question: string,
  answer: string,
  options: { model?: string } = {},
): Promise<CriticVerdict> {
  // Skip critic for very short answers (handled by basic validation)
  if (answer.trim().length < 30) {
    return { pass: false, reason: 'Answer is too short to be useful.', confidence: 1.0 };
  }

  try {
    const request = {
      messages: [{
        role: 'user' as const,
        content: [
          '## Original Question',
          '',
          question,
          '',
          '## Proposed Answer',
          '',
          answer.slice(0, 3000), // Cap answer length sent to critic
        ].join('\n'),
      }],
      model: options.model,
      temperature: 0.1,
      maxTokens: 150,
      systemPrompt: CRITIC_SYSTEM_PROMPT,
    };

    let response = '';
    const stream = provider.streamCompletion(request);
    for await (const chunk of stream) {
      if (!chunk.done) response += chunk.delta;
    }

    return parseCriticResponse(response.trim());
  } catch {
    // Critic failure is non-fatal — default to pass
    return { pass: true, reason: 'Critic evaluation failed, defaulting to pass.', confidence: 0.0 };
  }
}

/**
 * Parse the critic's structured response.
 */
function parseCriticResponse(text: string): CriticVerdict {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  if (lines.length === 0) {
    return { pass: true, reason: 'Empty critic response.', confidence: 0.0 };
  }

  const firstLine = lines[0]!.toUpperCase();
  const pass = firstLine.includes('PASS');

  // Extract confidence
  let confidence = 0.5;
  const confLine = lines.find(l => l.toUpperCase().startsWith('CONFIDENCE'));
  if (confLine) {
    const match = confLine.match(/[\d.]+/);
    if (match) confidence = Math.min(1, Math.max(0, parseFloat(match[0])));
  }

  // Extract reason
  let reason = 'No reason provided.';
  const reasonLine = lines.find(l => l.toUpperCase().startsWith('REASON'));
  if (reasonLine) {
    reason = reasonLine.replace(/^REASON:\s*/i, '').trim();
  }

  return { pass, reason, confidence };
}

/**
 * Build a correction message from the critic's feedback.
 * More specific than the generic buildCorrectionMessage.
 */
export function buildCriticCorrection(verdict: CriticVerdict, originalQuestion: string): string {
  return [
    `[CRITIC FEEDBACK: Your answer was rejected.]`,
    '',
    `Reason: ${verdict.reason}`,
    '',
    `The user's original question was: "${originalQuestion}"`,
    '',
    'Provide a NEW answer that:',
    '1. Directly addresses the question above',
    '2. References specific file paths, line numbers, and code snippets',
    '3. Is formatted in clean Markdown',
    '4. Does NOT repeat your previous answer',
    '',
    'If you need more information, use tools to search and read code first.',
  ].join('\n');
}
