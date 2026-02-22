/**
 * Shared agentic-loop intelligence for `jam ask`, `jam chat`, and `jam run`.
 *
 * This module provides:
 * - ReAct-style system prompt builder (with JAM.md / workspace context)
 * - Query/prompt enrichment with search strategy guidance
 * - Tool-call loop detection, duplicate skipping, and correction hints
 * - Answer self-validation (JSON detection, too-short, empty)
 *
 * Individual commands wire these into their own UI layer (stdout streaming,
 * Ink TUI, or plain stderr).
 */

import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { loadContextFile } from './context.js';

// ── ANSI helpers ──────────────────────────────────────────────────────────────

export const ANSI = {
  reset:   '\x1b[0m',
  dim:     '\x1b[2m',
  bold:    '\x1b[1m',
  cyan:    '\x1b[36m',
  yellow:  '\x1b[33m',
  green:   '\x1b[32m',
  magenta: '\x1b[35m',
  gray:    '\x1b[90m',
  white:   '\x1b[37m',
  blue:    '\x1b[34m',
  red:     '\x1b[31m',
} as const;

export function ansi(code: string, text: string): string {
  return `${code}${text}${ANSI.reset}`;
}

// ── Workspace context ─────────────────────────────────────────────────────────

/** Build a concise workspace overview for the system prompt. */
export async function buildWorkspaceContext(workspaceRoot: string): Promise<string> {
  const projectName = basename(workspaceRoot);
  let entries: string[];
  try {
    const dirEntries = await readdir(workspaceRoot, { withFileTypes: true });
    entries = dirEntries
      .filter(e => !String(e.name).startsWith('.') && String(e.name) !== 'node_modules' && String(e.name) !== 'dist')
      .map(e => e.isDirectory() ? `${String(e.name)}/` : String(e.name))
      .sort();
  } catch {
    entries = [];
  }

  const hasTs = entries.some(e => e === 'tsconfig.json');
  const hasPkg = entries.some(e => e === 'package.json');
  const hasSrc = entries.some(e => e === 'src/');

  let srcTree = '';
  if (hasSrc) {
    try {
      const srcEntries = await readdir(join(workspaceRoot, 'src'), { withFileTypes: true });
      const srcItems = srcEntries
        .filter(e => !String(e.name).startsWith('.'))
        .map(e => e.isDirectory() ? `  ${String(e.name)}/` : `  ${String(e.name)}`)
        .sort();
      srcTree = `\nsrc/ contents:\n${srcItems.join('\n')}`;
    } catch { /* ignore */ }
  }

  const lang = hasTs ? 'TypeScript' : hasPkg ? 'JavaScript/Node.js' : 'unknown';

  return [
    `Project: ${projectName}`,
    `Language: ${lang}`,
    hasTs ? 'Source files use .ts extension — always search *.ts files, NOT *.js' : '',
    `\nRoot files:\n${entries.map(e => `  ${e}`).join('\n')}`,
    srcTree,
  ].filter(Boolean).join('\n');
}

/**
 * Load JAM.md if present, otherwise fall back to auto-detected workspace context.
 */
export async function loadProjectContext(workspaceRoot: string): Promise<{
  jamContext: string | null;
  workspaceCtx: string;
}> {
  const [jamContext, workspaceCtx] = await Promise.all([
    loadContextFile(workspaceRoot),
    buildWorkspaceContext(workspaceRoot),
  ]);
  return { jamContext, workspaceCtx };
}

// ── System prompt builder ─────────────────────────────────────────────────────

export interface SystemPromptOptions {
  /** 'readonly' for ask/chat, 'readwrite' for run */
  mode: 'readonly' | 'readwrite';
  /** Workspace root path (for run command context) */
  workspaceRoot?: string;
}

/**
 * Build a ReAct-style system prompt with project context.
 */
export function buildSystemPrompt(
  jamContext: string | null,
  workspaceCtx: string,
  options: SystemPromptOptions = { mode: 'readonly' },
): string {
  const modeDesc = options.mode === 'readwrite'
    ? 'You are an expert developer assistant with full read/write access to the local codebase via tools.'
    : 'You are an expert code assistant. You help developers understand their codebase by reading and searching source files.';

  return [
    modeDesc,
    '',
    // Project context
    ...(jamContext
      ? ['## Project Context', '', jamContext]
      : ['## Workspace Info', '', workspaceCtx]),
    '',
    options.workspaceRoot ? `Workspace root: ${options.workspaceRoot}` : '',
    '',
    '## Your Behavior',
    '',
    'You follow the ReAct (Reason → Act → Observe) pattern:',
    '1. **Reason**: Think about what you need to find. Identify specific code identifiers (function names, class names, imports, variable names) to search for.',
    '2. **Act**: Use tools to search for those specific identifiers and read relevant files.',
    '3. **Observe**: Look at the results. Did you find what you need? If not, reason about different terms to try.',
    '4. **Repeat** until you have enough context, then give your final answer.',
    '',
    '## CRITICAL Rules',
    '',
    '- NEVER search for vague English words. Always search for actual code identifiers that would appear in source files.',
    '- NEVER repeat a search with the same query. If it returned no results, the term does not exist — try something else.',
    '- NEVER pass an empty string as a search query.',
    '- NEVER output raw JSON as your answer. Always respond in clean, readable Markdown.',
    '- NEVER ask the user for information you can discover by reading code.',
    '- ALWAYS read files to verify your understanding before answering.',
    '- ALWAYS reference specific file paths and line numbers in your answer.',
    '- When you have gathered enough context, provide a clear, well-structured Markdown answer with code snippets.',
    ...(options.mode === 'readwrite' ? [
      '- For write operations, explain what you are changing and why BEFORE making the change.',
      '- Always validate changes after making them (e.g. read the file back to confirm).',
    ] : []),
  ].filter(Boolean).join('\n');
}

// ── Query expansion / prompt enrichment ───────────────────────────────────────

/**
 * Enrich the user's prompt with search strategy guidance.
 * Helps the model think about what code identifiers to search for
 * instead of searching for vague English terms.
 */
export function enrichUserPrompt(prompt: string): string {
  return [
    prompt,
    '',
    '---',
    '**Before you search, THINK about the user\'s question:**',
    '1. What concepts does the user\'s question involve?',
    '2. What are the likely function names, class names, file names, or variable names in the code for those concepts?',
    '3. Plan 2–3 different search queries using those specific identifiers.',
    '',
    '**Search strategy:**',
    '- NEVER search for vague/generic words. Search for specific code identifiers (function names, class names, imports).',
    '- If the user asks about "LLM calls", search for `fetch`, `api/chat`, `streamCompletion`, `chatWithTools`, `provider`, `adapter` — not "llm".',
    '- If the user asks about "database", search for `query`, `connection`, `pool`, `prisma`, `knex`, `sequelize` — not "database".',
    '- If a search returns no results, try a DIFFERENT term, not the same one again.',
    '- Use `glob="*.ts"` for TypeScript projects to avoid searching compiled files.',
    '- After finding relevant files, use read_file to understand the full context.',
    '',
    '**When answering:**',
    '- Give a direct, specific answer with file paths and line numbers.',
    '- Show relevant code snippets.',
    '- Format your answer in clean Markdown.',
    '- Do NOT output JSON. Do NOT ask the user clarifying questions — find the answer yourself.',
  ].join('\n');
}

// ── Tool call tracking / loop detection ───────────────────────────────────────

interface ToolCallRecord { name: string; args: string }

export class ToolCallTracker {
  private history: ToolCallRecord[] = [];
  private errorCount = 0;

  record(name: string, args: Record<string, unknown>, wasError: boolean): void {
    this.history.push({ name, args: JSON.stringify(args) });
    if (wasError) this.errorCount++;
  }

  /** Detect if a call was already made (exact duplicate). */
  isDuplicate(name: string, args: Record<string, unknown>): boolean {
    const key = JSON.stringify(args);
    return this.history.some(h => h.name === name && h.args === key);
  }

  /** Build a correction hint if the model is stuck. */
  getCorrectionHint(): string | null {
    if (this.history.length < 2) return null;

    // Check for repeated failures
    if (this.errorCount >= 2) {
      return '[SYSTEM HINT: Multiple tool errors detected. Make sure the "query" argument is a non-empty, specific string. Try searching for function names, class names, or import statements instead of generic terms.]';
    }

    // Check for duplicate calls
    const seen = new Set<string>();
    let dupes = 0;
    for (const h of this.history) {
      const key = `${h.name}:${h.args}`;
      if (seen.has(key)) dupes++;
      seen.add(key);
    }
    if (dupes >= 2) {
      return '[SYSTEM HINT: You are repeating the same searches. STOP and try completely different search terms. Think about what function names, class names, or variable names would exist in the code. Search for those specific identifiers instead.]';
    }

    // Check for too many rounds with no progress
    const lastThree = this.history.slice(-3);
    const allSameType = lastThree.length === 3 && lastThree.every(h => h.name === 'search_text');
    if (allSameType) {
      return '[SYSTEM HINT: You have been searching repeatedly. Try using list_dir to explore the directory structure, or read_file to look at specific files that seem relevant based on their names.]';
    }

    return null;
  }

  get totalCalls(): number { return this.history.length; }

  /** Reset for a new turn (useful in multi-turn chat). */
  reset(): void {
    this.history = [];
    this.errorCount = 0;
  }
}

// ── Answer self-validation ────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Check if the model's final answer looks acceptable.
 * Returns { valid: false, reason } if it looks like garbage.
 */
export function validateAnswer(text: string, hadToolCalls: boolean): ValidationResult {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return { valid: false, reason: 'You produced an empty response.' };
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    // Allow short JSON-like responses if they're clearly code examples inside markdown
    if (!trimmed.includes('```') && trimmed.length > 10) {
      return { valid: false, reason: 'You output raw JSON instead of a Markdown answer.' };
    }
  }

  if (hadToolCalls && trimmed.length < 20) {
    return { valid: false, reason: 'Your answer was too short and unhelpful.' };
  }

  return { valid: true };
}

/**
 * Build a correction message to inject when the answer is invalid.
 */
export function buildCorrectionMessage(reason: string): string {
  return [
    `[SYSTEM: Your previous response was not acceptable. ${reason}`,
    'Please search for more relevant code if needed and provide a proper, detailed Markdown answer with:',
    '- Specific file paths and line numbers',
    '- Relevant code snippets',
    '- A clear explanation',
    'Do NOT output JSON. Write a clean Markdown response.]',
  ].join(' ');
}

// ── Formatting helpers ────────────────────────────────────────────────────────

/** Format a tool call for display. */
export function formatToolCall(name: string, args: Record<string, unknown>, noColor: boolean): string {
  if (noColor) {
    return `  ▸ ${name}(${Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})`;
  }
  const formattedArgs = Object.entries(args)
    .map(([k, v]) => `${ansi(ANSI.white, k)}${ansi(ANSI.gray, '=')}${ansi(ANSI.yellow, JSON.stringify(v))}`)
    .join(ansi(ANSI.gray, ', '));
  return `  ${ansi(ANSI.cyan, '▸')} ${ansi(ANSI.bold + ANSI.cyan, name)}${ansi(ANSI.gray, '(')}${formattedArgs}${ansi(ANSI.gray, ')')}`;
}

/** Format a tool result summary for display. */
export function formatToolResult(output: string, noColor: boolean): string {
  const maxLen = 200;
  const preview = output.replace(/\n/g, ' ↵ ').slice(0, maxLen);
  const truncated = output.length > maxLen ? '…' : '';
  if (noColor) {
    return `    → ${preview}${truncated}`;
  }
  return `    ${ansi(ANSI.green, '→')} ${ansi(ANSI.dim, preview + truncated)}`;
}

/** Print a section separator. */
export function formatSeparator(label: string, noColor: boolean): string {
  const line = '─'.repeat(Math.max(0, 60 - label.length - 2));
  if (noColor) {
    return `\n── ${label} ${line}\n`;
  }
  return `\n${ansi(ANSI.dim, '── ')}${ansi(ANSI.bold + ANSI.magenta, label)} ${ansi(ANSI.dim, line)}\n`;
}

/** Format a duplicate skip message. */
export function formatDuplicateSkip(name: string, noColor: boolean): string {
  if (noColor) {
    return `  ✕ skipped duplicate: ${name}`;
  }
  return `  ${ansi(ANSI.red, '✕')} ${ansi(ANSI.dim, `skipped duplicate: ${name}`)}`;
}

/** Format a retry/validation message. */
export function formatRetry(message: string, noColor: boolean): string {
  if (noColor) {
    return `  ⟳ ${message}`;
  }
  return `  ${ansi(ANSI.yellow, '⟳')} ${ansi(ANSI.dim, message)}`;
}

/** Format a correction hint injection message. */
export function formatHintInjection(noColor: boolean): string {
  if (noColor) {
    return `  ⚠ injecting search guidance…`;
  }
  return `  ${ansi(ANSI.yellow, '⚠')} ${ansi(ANSI.dim, 'injecting search guidance…')}`;
}

/** Format usage stats. */
export function formatUsage(
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
  noColor: boolean,
): string {
  const str = `tokens: ${promptTokens} prompt + ${completionTokens} completion = ${totalTokens} total`;
  return noColor ? str : ansi(ANSI.dim, str);
}
