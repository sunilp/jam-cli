/**
 * Token estimation utilities for context window management.
 *
 * Uses a heuristic character-to-token ratio rather than a full tokenizer
 * to keep dependencies minimal.  The ratios are calibrated for typical
 * code / English text seen by llama-family models (~3.5–4 chars per token).
 *
 * The key concern is *budget management* — we don't need exact counts,
 * just good-enough estimates to decide when to evict or summarize.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Average characters per token for English + code. */
const CHARS_PER_TOKEN = 3.8;

/**
 * Known context-window sizes (tokens) for popular local models.
 * Used as fallback when the provider doesn't report a limit.
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'llama3.2':        128_000,
  'llama3.2:1b':       8_192,
  'llama3.2:3b':     128_000,
  'llama3.1':        128_000,
  'llama3':            8_192,
  'llama2':            4_096,
  'mistral':           8_192,
  'mixtral':          32_768,
  'codellama':        16_384,
  'deepseek-coder':   16_384,
  'deepseek-coder-v2':128_000,
  'qwen2.5-coder':   128_000,
  'phi3':             128_000,
  'gemma2':             8_192,
  'command-r':        128_000,
};

/** Safe default when model is unknown (conservative). */
const DEFAULT_CONTEXT_LIMIT = 8_192;

/**
 * How much of the context window we're willing to fill with messages.
 * Leave headroom for the model's own generation and system prompt.
 */
const USAGE_RATIO = 0.75;

// ── Estimation functions ──────────────────────────────────────────────────────

/** Rough token count for a string. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimate tokens for an array of messages (role + content). */
export function estimateMessageTokens(messages: Array<{ role: string; content: string }>): number {
  let total = 0;
  for (const msg of messages) {
    // ~4 tokens overhead per message for role, delimiters
    total += 4 + estimateTokens(msg.content);
  }
  return total;
}

/**
 * Get the effective context budget for a model (in tokens).
 * This is the max tokens we allow in the message array before
 * triggering summarization / eviction.
 */
export function getContextBudget(model?: string): number {
  if (!model) return Math.floor(DEFAULT_CONTEXT_LIMIT * USAGE_RATIO);

  // Try exact match first, then prefix match
  const lower = model.toLowerCase();
  const limit = MODEL_CONTEXT_LIMITS[lower]
    ?? Object.entries(MODEL_CONTEXT_LIMITS).find(([k]) => lower.startsWith(k))?.[1]
    ?? DEFAULT_CONTEXT_LIMIT;

  return Math.floor(limit * USAGE_RATIO);
}

/**
 * Check whether the current messages exceed the context budget.
 * Returns { overBudget, currentTokens, budget, excess }.
 */
export function checkBudget(
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string | undefined,
  model?: string,
): { overBudget: boolean; currentTokens: number; budget: number; excess: number } {
  const budget = getContextBudget(model);
  const systemTokens = systemPrompt ? estimateTokens(systemPrompt) + 4 : 0;
  const msgTokens = estimateMessageTokens(messages);
  const currentTokens = systemTokens + msgTokens;
  const excess = currentTokens - budget;

  return {
    overBudget: excess > 0,
    currentTokens,
    budget,
    excess: Math.max(0, excess),
  };
}

// ── Text truncation helpers ───────────────────────────────────────────────────

/**
 * Truncate text to fit within a token budget, keeping the beginning and end
 * (most useful context is usually at boundaries).
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return text;

  const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
  const keepChars = Math.floor(maxChars * 0.45); // 45% from start, 45% from end, ~10% for marker

  const head = text.slice(0, keepChars);
  const tail = text.slice(-keepChars);
  const omittedTokens = estimated - maxTokens;

  return `${head}\n\n[… ~${omittedTokens} tokens omitted …]\n\n${tail}`;
}

/**
 * Truncate tool output (file contents, search results) to a sensible size.
 * - File reads: keep first + last N lines
 * - Search results: keep first N matches
 */
export function truncateToolOutput(
  toolName: string,
  output: string,
  maxTokens: number = 1500,
): string {
  const estimated = estimateTokens(output);
  if (estimated <= maxTokens) return output;

  if (toolName === 'read_file') {
    // For file reads, keep head + tail for best context
    const lines = output.split('\n');
    const maxLines = Math.floor(maxTokens / 10); // ~10 tokens per line avg
    if (lines.length <= maxLines) return output;

    const keepLines = Math.floor(maxLines * 0.45);
    const head = lines.slice(0, keepLines).join('\n');
    const tail = lines.slice(-keepLines).join('\n');
    const omitted = lines.length - keepLines * 2;
    return `${head}\n\n[… ${omitted} lines omitted …]\n\n${tail}`;
  }

  if (toolName === 'search_text') {
    // For search results, keep first N results (most relevant)
    const lines = output.split('\n');
    const maxLines = Math.floor(maxTokens / 8);
    if (lines.length <= maxLines) return output;
    return lines.slice(0, maxLines).join('\n') + `\n\n[… ${lines.length - maxLines} more results truncated]`;
  }

  // Generic truncation
  return truncateToTokenBudget(output, maxTokens);
}
