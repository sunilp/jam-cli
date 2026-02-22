/**
 * Working memory management for the agentic loop.
 *
 * Provides:
 * - **Context compaction** — summarize old tool results when approaching the
 *   context window limit.
 * - **Scratchpad** — periodic "what have I learned" prompts that create a
 *   running working memory the model can reference.
 * - **Tool result capping** — truncate oversized tool outputs before injection.
 *
 * The core idea: instead of feeding the LLM an ever-growing message array,
 * we periodically compress old rounds into a compact summary and carry only
 * recent rounds + the summary forward.
 */

import type { Message } from '../providers/base.js';
import type { ProviderAdapter } from '../providers/base.js';
import {
  estimateMessageTokens,
  estimateTokens,
  checkBudget,
  truncateToolOutput,
} from './tokens.js';

// ── Configuration ─────────────────────────────────────────────────────────────

/** After this many tool rounds, inject a scratchpad prompt. */
export const SCRATCHPAD_INTERVAL = 3;

/** When messages exceed this fraction of the context budget, compact. */
const COMPACTION_THRESHOLD = 0.70;

/** Max token budget for a single tool result injection. */
export const MAX_TOOL_RESULT_TOKENS = 1500;

/** Max token budget for compacted summary. */
const MAX_SUMMARY_TOKENS = 800;

// ── Tool result capping (P0-2) ────────────────────────────────────────────────

/**
 * Cap a tool output to prevent oversized injections into the message array.
 * Call this BEFORE pushing the tool result into `messages`.
 */
export function capToolResult(toolName: string, output: string): string {
  return truncateToolOutput(toolName, output, MAX_TOOL_RESULT_TOKENS);
}

// ── Scratchpad (P1-4) ────────────────────────────────────────────────────────

const SCRATCHPAD_PROMPT = `[WORKING MEMORY CHECKPOINT]

Pause and organize what you have learned so far.  Write a brief, structured note:

1. **Files examined**: List every file path you have read or searched.
2. **Key findings**: List the most important facts you found (function names, patterns, locations).
3. **Still needed**: What information do you still need to answer the user's question?

Keep this under 200 words.  This note will stay in your context as working memory.`;

/**
 * Check if it's time to inject a scratchpad prompt.
 * Returns true every SCRATCHPAD_INTERVAL tool rounds.
 */
export function shouldInjectScratchpad(toolRound: number): boolean {
  return toolRound > 0 && toolRound % SCRATCHPAD_INTERVAL === 0;
}

/**
 * Build the scratchpad injection message.
 */
export function buildScratchpadPrompt(): Message {
  return { role: 'user', content: SCRATCHPAD_PROMPT };
}

// ── Context compaction / summarization (P0-3) ─────────────────────────────────

/**
 * Check whether the message array needs compaction.
 */
export function needsCompaction(
  messages: Message[],
  systemPrompt: string | undefined,
  model?: string,
): boolean {
  const { budget, currentTokens } = checkBudget(messages, systemPrompt, model);
  return currentTokens > budget * COMPACTION_THRESHOLD;
}

const SUMMARIZER_SYSTEM_PROMPT = `You are a context summarizer for a code assistant. You will receive a conversation between a user and an assistant that includes tool calls and their results.

Your job is to produce a COMPACT summary of all the information gathered so far. Include:
1. Files that were examined (paths only)
2. Key code facts discovered (function names, class names, patterns, important line numbers)
3. Any errors or dead-ends encountered

Rules:
- Be extremely concise — bullet points only
- Include file paths and line numbers where relevant
- Do NOT include opinions or analysis — just facts
- Do NOT include the full contents of files — just what was found
- Stay under 300 words`;

/**
 * Compact the message array by summarizing old tool rounds.
 *
 * Strategy:
 * 1. Keep the first message (original user query) and the last N messages (recent context).
 * 2. Summarize everything in between via a cheap LLM call.
 * 3. Replace the middle messages with a single summary message.
 *
 * Falls back to a simple truncation if the LLM call fails.
 */
export async function compactMessages(
  messages: Message[],
  provider: ProviderAdapter,
  options: { model?: string; keepRecent?: number },
): Promise<Message[]> {
  const keepRecent = options.keepRecent ?? 6; // Keep last 6 messages (3 rounds)

  // Not enough messages to compact
  if (messages.length <= keepRecent + 2) return messages;

  const firstMessage = messages[0]!;
  const middleMessages = messages.slice(1, -keepRecent);
  const recentMessages = messages.slice(-keepRecent);

  // Build a condensed representation of middle messages for the summarizer
  const middleText = middleMessages
    .map((m, i) => `[${m.role}] ${m.content.slice(0, 500)}${m.content.length > 500 ? '…' : ''}`)
    .join('\n---\n');

  // Try to summarize via LLM
  try {
    const summaryRequest = {
      messages: [{
        role: 'user' as const,
        content: `Summarize the following conversation context:\n\n${middleText}`,
      }],
      model: options.model,
      temperature: 0.1, // Very focused
      maxTokens: 500,
      systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
    };

    let summary = '';
    const stream = provider.streamCompletion(summaryRequest);
    for await (const chunk of stream) {
      if (!chunk.done) summary += chunk.delta;
    }

    const trimmedSummary = summary.trim();
    if (trimmedSummary.length > 20) {
      // Successfully summarized — replace middle with summary
      const summaryMessage: Message = {
        role: 'user',
        content: `[CONTEXT SUMMARY — earlier tool results compressed]\n\n${trimmedSummary}\n\n[End of summary — recent context follows]`,
      };

      return [firstMessage, summaryMessage, ...recentMessages];
    }
  } catch {
    // Summarization failed — fall back to simple truncation
  }

  // Fallback: just keep first + truncated middle + recent
  const fallbackSummary: Message = {
    role: 'user',
    content: `[CONTEXT NOTE: ${middleMessages.length} earlier messages were compressed to save context space. Key info may need to be re-discovered if not in recent messages.]`,
  };

  return [firstMessage, fallbackSummary, ...recentMessages];
}

// ── Combined memory manager ───────────────────────────────────────────────────

/**
 * WorkingMemory manages the conversation's context budget throughout
 * the agentic loop.  Commands use it like:
 *
 * ```ts
 * const memory = new WorkingMemory(provider, model, systemPrompt);
 * // In the tool loop:
 * memory.addToolResult(toolName, output, messages);
 * if (memory.shouldScratchpad(round)) messages.push(memory.scratchpadPrompt());
 * if (memory.shouldCompact(messages)) messages = await memory.compact(messages);
 * ```
 */
export class WorkingMemory {
  private provider: ProviderAdapter;
  private model?: string;
  private systemPrompt?: string;
  private readFiles: Set<string> = new Set();
  private searchQueries: Set<string> = new Set();
  private factsLearned: string[] = [];

  constructor(provider: ProviderAdapter, model?: string, systemPrompt?: string) {
    this.provider = provider;
    this.model = model;
    this.systemPrompt = systemPrompt;
  }

  /**
   * Process and cap a tool result before injection into messages.
   * Also tracks which files/searches have been done.
   */
  processToolResult(toolName: string, args: Record<string, unknown>, output: string): string {
    // Track what we've accessed
    if (toolName === 'read_file' && args['path']) {
      this.readFiles.add(String(args['path']));
    }
    if (toolName === 'search_text' && args['query']) {
      this.searchQueries.add(String(args['query']));
    }

    // Cap the output
    return capToolResult(toolName, output);
  }

  /**
   * Check if we should inject a scratchpad prompt at this round.
   */
  shouldScratchpad(round: number): boolean {
    return shouldInjectScratchpad(round);
  }

  /**
   * Build the scratchpad prompt.
   */
  scratchpadPrompt(): Message {
    return buildScratchpadPrompt();
  }

  /**
   * Check if messages need compaction.
   */
  shouldCompact(messages: Message[]): boolean {
    return needsCompaction(messages, this.systemPrompt, this.model);
  }

  /**
   * Compact the messages array.
   */
  async compact(messages: Message[]): Promise<Message[]> {
    return compactMessages(messages, this.provider, { model: this.model });
  }

  /**
   * Get a summary of what has been accessed (for diagnostics / JAM.md updates).
   */
  getAccessLog(): { readFiles: string[]; searchQueries: string[] } {
    return {
      readFiles: [...this.readFiles],
      searchQueries: [...this.searchQueries],
    };
  }

  /** Reset for a new turn (multi-turn chat). */
  reset(): void {
    // Don't reset readFiles/searchQueries — they're session-level
  }
}
