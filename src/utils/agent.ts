/**
 * Shared agentic-loop intelligence for `jam ask`, `jam chat`, and `jam run`.
 *
 * This module provides:
 * - Search planner (separate LLM reasoning step before tool use)
 * - ReAct-style system prompt builder (with JAM.md / workspace context)
 * - Query/prompt enrichment with plan-driven search guidance
 * - Tool-call loop detection, duplicate skipping, and correction hints
 * - Answer self-validation (JSON detection, too-short, empty, off-topic)
 * - Synthesis grounding (reminds model of original question before answering)
 *
 * Individual commands wire these into their own UI layer (stdout streaming,
 * Ink TUI, or plain stderr).
 */

import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { loadContextFile } from './context.js';
import type { ProviderAdapter, Message } from '../providers/base.js';

// ── ANSI helpers ──────────────────────────────────────────────────────────────

export const ANSI = {
  reset:   '\x1b[0m',
  dim:     '\x1b[2m',
  bold:    '\x1b[1m',
  italic:  '\x1b[3m',
  cyan:    '\x1b[36m',
  yellow:  '\x1b[33m',
  green:   '\x1b[32m',
  magenta: '\x1b[35m',
  gray:    '\x1b[90m',
  white:   '\x1b[37m',
  blue:    '\x1b[34m',
  red:     '\x1b[31m',
  // Dim variants for subtle output
  dimBlue:    '\x1b[2m\x1b[34m',
  dimCyan:    '\x1b[2m\x1b[36m',
  dimGreen:   '\x1b[2m\x1b[32m',
  dimYellow:  '\x1b[2m\x1b[33m',
  dimMagenta: '\x1b[2m\x1b[35m',
  dimGray:    '\x1b[2m\x1b[90m',
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
    '- NEVER just describe code you read. Always answer the user\'s SPECIFIC question.',
    '- ALWAYS read files to verify your understanding before answering.',
    '- ALWAYS reference specific file paths and line numbers in your answer.',
    '- ALWAYS relate your findings back to the user\'s original question.',
    '- When you have gathered enough context, provide a clear, well-structured Markdown answer with code snippets.',
    ...(options.mode === 'readwrite' ? [
      '- For write operations, explain what you are changing and why BEFORE making the change.',
      '- Always validate changes after making them (e.g. read the file back to confirm).',
    ] : []),
  ].filter(Boolean).join('\n');
}

// ── Search planner (deep reasoning step) ──────────────────────────────────────

const PLANNER_SYSTEM_PROMPT = `You are a search planner for a code assistant. Your job is to analyze the user's question and create a focused search plan.

You will receive:
1. A user's question about a codebase
2. Project context (language, framework, directory structure)

You must output a search plan with:
1. QUESTION INTENT: What the user is really asking (1 sentence)
2. KEY CONCEPTS: What code constructs relate to this question (function names, class names, patterns, file names)
3. SEARCH QUERIES: 3-5 specific strings to search for in the codebase (actual code identifiers, NOT English words)
4. DIRECTORIES: Which directories to explore first

Be VERY specific. For example:
- "where to add chatgpt as LLM" → search for: "ProviderAdapter", "createProvider", "OllamaProvider", "factory" — NOT "chatgpt" or "llm"
- "how does auth work" → search for: "authenticate", "token", "session", "middleware", "login" — NOT "auth" or "security"
- "where is the database connection" → search for: "createConnection", "pool", "DataSource", "prisma", "knex" — NOT "database"

Output ONLY the plan in the exact format above. Be concise.`;

/**
 * Generate a search plan by asking the model to reason about what to search for.
 * This is a separate LLM call (no tools) that produces a focused plan
 * for the agentic tool loop.
 *
 * Returns the plan text, or null if planning fails.
 */
export async function generateSearchPlan(
  provider: ProviderAdapter,
  question: string,
  projectContext: string,
  options: { model?: string; temperature?: number; maxTokens?: number },
): Promise<string | null> {
  try {
    const planRequest = {
      messages: [{
        role: 'user' as const,
        content: [
          `User's question: "${question}"`,
          '',
          'Project context:',
          projectContext,
          '',
          'Create a search plan for finding the answer in this codebase.',
        ].join('\n'),
      }],
      model: options.model,
      temperature: 0.3, // Low temperature for focused planning
      maxTokens: 400,   // Plan should be concise
      systemPrompt: PLANNER_SYSTEM_PROMPT,
    };

    let plan = '';
    const stream = provider.streamCompletion(planRequest);
    for await (const chunk of stream) {
      if (!chunk.done) plan += chunk.delta;
    }

    const trimmed = plan.trim();
    // Sanity check: plan should be non-empty and not too short
    if (trimmed.length < 20) return null;
    return trimmed;
  } catch {
    // Planning failure is non-fatal
    return null;
  }
}

// ── Structured Execution Plan ─────────────────────────────────────────────────

/** One step in a structured execution plan. */
export interface PlanStep {
  /** Sequential step number starting at 1. */
  id: number;
  /** Human-readable description, e.g. "Search for createProvider in factory.ts". */
  action: string;
  /** Tool to use: 'search_text' | 'read_file' | 'list_dir'. */
  tool: string;
  /** Exact arguments to pass to the tool. */
  args: Record<string, unknown>;
  /** What constitutes success, e.g. "Found function signature in src/providers/factory.ts". */
  successCriteria: string;
}

/** A structured execution plan produced by the planner LLM call. */
export interface ExecutionPlan {
  /** One-sentence restatement of what the user wants. */
  intent: string;
  /** Ordered steps to execute. */
  steps: PlanStep[];
  /** Planner's minimum number of steps before the executor should attempt an answer. */
  minStepsBeforeAnswer: number;
  /** Files likely to be relevant (hints for the executor). */
  expectedFiles: string[];
}

const STRUCTURED_PLANNER_SYSTEM_PROMPT = `You are an execution planner for a code assistant. Produce a precise, ordered JSON plan for answering a question about a codebase.

Output a JSON object with EXACTLY this structure (no prose, no markdown, just JSON):
{
  "intent": "one sentence: what the user actually wants",
  "steps": [
    {
      "id": 1,
      "action": "Search for createProvider function definition",
      "tool": "search_text",
      "args": { "query": "createProvider", "glob": "*.ts", "max_results": 10 },
      "successCriteria": "Found the file and line where createProvider is defined"
    }
  ],
  "minStepsBeforeAnswer": 2,
  "expectedFiles": ["src/providers/factory.ts"]
}

RULES:
- steps must only use tools: search_text, read_file, list_dir
- search_text args: { "query": "...", "glob": "*.ts" }  (query MUST be a specific code identifier — function name, class name, import path, variable name — NEVER a generic English word)
- read_file args: { "path": "src/some/file.ts" }
- list_dir args: { "path": "src/some/" }
- 2 to 6 steps only
- Output ONLY the raw JSON object. No markdown fences, no explanation.`;

/**
 * Generate a structured, typed execution plan.
 * Falls back to null on parse failure — callers should fall back to generateSearchPlan.
 */
export async function generateExecutionPlan(
  provider: ProviderAdapter,
  question: string,
  projectContext: string,
  options: { model?: string; temperature?: number; maxTokens?: number },
): Promise<ExecutionPlan | null> {
  try {
    const request = {
      messages: [{
        role: 'user' as const,
        content: [
          `Question: "${question}"`,
          '',
          'Project context:',
          projectContext,
          '',
          'Produce a precise execution plan as a JSON object.',
        ].join('\n'),
      }],
      model: options.model,
      temperature: 0.1,
      maxTokens: 600,
      systemPrompt: STRUCTURED_PLANNER_SYSTEM_PROMPT,
    };

    let raw = '';
    const stream = provider.streamCompletion(request);
    for await (const chunk of stream) {
      if (!chunk.done) raw += chunk.delta;
    }

    return parseExecutionPlan(raw.trim());
  } catch {
    return null;
  }
}

/**
 * Parse a JSON execution plan from the model's response.
 * Handles markdown code-block wrappers and leading/trailing prose.
 */
export function parseExecutionPlan(text: string): ExecutionPlan | null {
  // Strip markdown code block wrappers if present
  let cleaned = text
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  // Find the outermost JSON object
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  cleaned = cleaned.slice(start, end + 1);

  try {
    const parsed: unknown = JSON.parse(cleaned);
    return isValidExecutionPlan(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isValidExecutionPlan(obj: unknown): obj is ExecutionPlan {
  if (typeof obj !== 'object' || obj === null) return false;
  const p = obj as Record<string, unknown>;
  if (typeof p['intent'] !== 'string') return false;
  if (!Array.isArray(p['steps']) || p['steps'].length === 0) return false;
  if (typeof p['minStepsBeforeAnswer'] !== 'number') return false;
  if (!Array.isArray(p['expectedFiles'])) return false;
  for (const step of p['steps'] as unknown[]) {
    if (typeof step !== 'object' || step === null) return false;
    const s = step as Record<string, unknown>;
    if (typeof s['id'] !== 'number') return false;
    if (typeof s['action'] !== 'string') return false;
    if (typeof s['tool'] !== 'string') return false;
    if (typeof s['args'] !== 'object' || s['args'] === null) return false;
    if (typeof s['successCriteria'] !== 'string') return false;
  }
  return true;
}

/**
 * Format an ExecutionPlan as a visual block for stderr display.
 */
export function formatExecutionPlanBlock(plan: ExecutionPlan, noColor: boolean): string {
  const lines = [
    `Intent: ${plan.intent}`,
    '',
    ...plan.steps.flatMap(s => [
      `Step ${s.id}: [${s.tool}] ${s.action}`,
      `  args: ${JSON.stringify(s.args)}`,
      `  ✓ ${s.successCriteria}`,
      '',
    ]),
    `Min steps before answering: ${plan.minStepsBeforeAnswer}`,
    ...(plan.expectedFiles.length > 0
      ? [`Expected files: ${plan.expectedFiles.join(', ')}`]
      : []),
  ].filter(l => l !== undefined);

  if (noColor) {
    return lines.map(l => `  │ ${l}`).join('\n');
  }
  return lines
    .map(l => `  ${ansi(ANSI.dimBlue, '│')} ${ansi(ANSI.dimBlue, l)}`)
    .join('\n');
}

/**
 * Enrich the user's prompt with a structured execution plan.
 * Gives the model explicit, ordered steps with exact tool args so it does not meander.
 */
export function enrichUserPromptWithPlan(prompt: string, plan: ExecutionPlan): string {
  const stepLines = plan.steps
    .map(s =>
      [
        `**Step ${s.id}:** ${s.action}`,
        `  - Tool: \`${s.tool}\` — args: \`${JSON.stringify(s.args)}\``,
        `  - Done when: ${s.successCriteria}`,
      ].join('\n')
    )
    .join('\n\n');

  return [
    prompt,
    '',
    '---',
    '',
    '## Execution Plan',
    '',
    `**Goal:** ${plan.intent}`,
    '',
    stepLines,
    '',
    `**Minimum ${plan.minStepsBeforeAnswer} step(s) required before answering.**`,
    plan.expectedFiles.length > 0
      ? `**Likely relevant files:** ${plan.expectedFiles.join(', ')}`
      : '',
    '',
    '## Instructions',
    '- Execute the steps above **in order**, using the exact tool and args listed.',
    '- Do not repeat a step you already completed.',
    `- After completing at least ${plan.minStepsBeforeAnswer} steps, synthesize your final answer.`,
    '- Final answer must be clean Markdown with specific file paths, line numbers, and code snippets.',
    '- Do NOT output raw JSON. Do NOT ask clarifying questions — the plan tells you what to find.',
  ].filter(Boolean).join('\n');
}

// ── Step Verifier ─────────────────────────────────────────────────────────────

/** Result from the step verifier mid-process check. */
export interface VerifierResult {
  /** Whether the agent has enough context to answer, needs more, or is stuck. */
  status: 'need-more' | 'ready-to-answer' | 'stuck';
  /** Next step ID to focus on (1-based). 0 when ready-to-answer. */
  nextStepId: number;
  /** Brief explanation. */
  reason: string;
}

const VERIFIER_SYSTEM_PROMPT = `You are a progress verifier for a code search agent.

You receive: the user's question, the execution plan, and a summary of tool results collected so far.

Determine the agent's status — output EXACTLY this format, nothing else:

STATUS: ready-to-answer
STEP: 0
REASON: Found the factory in src/providers/factory.ts with all provider cases covered.

or:

STATUS: need-more
STEP: 2
REASON: Found function signature but haven't read the file body yet.

or:

STATUS: stuck
STEP: 1
REASON: All searches returned no results — the queries used generic words instead of code identifiers.

Definitions:
- ready-to-answer: tool results contain specific file paths, code snippets, or data that directly answers the question
- need-more: some relevant info found but critical details still missing
- stuck: 3+ rounds of tool calls with no relevant results found`;

/**
 * Mid-process verifier: checks every N rounds whether the agent has enough
 * context to answer or is stuck. Enables early termination and targeted recovery.
 */
export class StepVerifier {
  /**
   * Run a cheap verifier LLM call against the current tool results.
   * Non-fatal — returns 'need-more' on any failure.
   */
  async verify(
    provider: ProviderAdapter,
    question: string,
    plan: ExecutionPlan | null,
    toolResultsSummary: string,
    options: { model?: string },
  ): Promise<VerifierResult> {
    const fallback: VerifierResult = { status: 'need-more', nextStepId: 1, reason: 'Verifier unavailable.' };
    try {
      const planText = plan
        ? plan.steps.map(s => `Step ${s.id}: [${s.tool}] ${s.action}`).join('\n')
        : '(no structured plan)';

      const request = {
        messages: [{
          role: 'user' as const,
          content: [
            '## Question',
            question,
            '',
            '## Execution Plan',
            planText,
            '',
            '## Tool Results So Far',
            toolResultsSummary || '(no results yet)',
          ].join('\n'),
        }],
        model: options.model,
        temperature: 0.1,
        maxTokens: 80,
        systemPrompt: VERIFIER_SYSTEM_PROMPT,
      };

      let raw = '';
      const stream = provider.streamCompletion(request);
      for await (const chunk of stream) {
        if (!chunk.done) raw += chunk.delta;
      }

      return this.parseVerifierResponse(raw.trim()) ?? fallback;
    } catch {
      return fallback;
    }
  }

  /** Parse the verifier's structured response. Exported for testing. */
  parseVerifierResponse(text: string): VerifierResult | null {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;

    const statusLine = lines.find(l => /^STATUS:/i.test(l));
    const stepLine   = lines.find(l => /^STEP:/i.test(l));
    const reasonLine = lines.find(l => /^REASON:/i.test(l));

    if (!statusLine) return null;

    const raw = statusLine.replace(/^STATUS:\s*/i, '').trim().toLowerCase();
    let status: VerifierResult['status'];
    if (raw.includes('ready')) status = 'ready-to-answer';
    else if (raw.includes('stuck')) status = 'stuck';
    else status = 'need-more';

    const nextStepId = stepLine
      ? (parseInt(stepLine.replace(/^STEP:\s*/i, '').trim(), 10) || 0)
      : 0;

    const reason = reasonLine
      ? reasonLine.replace(/^REASON:\s*/i, '').trim()
      : 'No reason provided.';

    return { status, nextStepId, reason };
  }
}

/**
 * Extract a summary of the most recent tool results from the message history.
 * Fed to the StepVerifier so it can assess progress without the full context.
 */
export function buildToolResultsSummary(messages: Message[]): string {
  const toolMsgs = messages
    .filter(m => m.role === 'user' && m.content.startsWith('[Tool result:'))
    .slice(-6);

  if (toolMsgs.length === 0) return '';

  return toolMsgs
    .map(m => {
      const content = m.content;
      return content.length > 300 ? content.slice(0, 300) + '…' : content;
    })
    .join('\n\n');
}

// ── Query expansion / prompt enrichment ────────────────────────────────────────

/**
 * Enrich the user's prompt with search strategy guidance.
 * If a search plan is provided, integrates it for focused searching.
 * Otherwise falls back to generic search guidance.
 */
export function enrichUserPrompt(prompt: string, searchPlan?: string | null): string {
  const parts = [prompt];

  if (searchPlan) {
    parts.push(
      '',
      '---',
      '',
      '## Your Search Plan',
      '',
      searchPlan,
      '',
      '## Instructions',
      '',
      '- Follow the search plan above. Start with the suggested search queries.',
      '- After finding relevant files, READ them to understand the full context.',
      '- Once you have enough information, answer the user\'s SPECIFIC question.',
      '- Do NOT just describe code you read. Directly answer what the user asked.',
      '- Reference specific file paths and line numbers.',
      '- Show relevant code snippets.',
      '- Format your answer in clean Markdown.',
      '- Do NOT output JSON.',
    );
  } else {
    parts.push(
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
      '- Directly answer the user\'s SPECIFIC question. Do NOT just describe code.',
      '- Give a direct, specific answer with file paths and line numbers.',
      '- Show relevant code snippets.',
      '- Format your answer in clean Markdown.',
      '- Do NOT output JSON. Do NOT ask the user clarifying questions — find the answer yourself.',
    );
  }

  return parts.join('\n');
}

// ── Synthesis grounding ───────────────────────────────────────────────────────

/**
 * Build a synthesis reminder that grounds the model back to the original question.
 * Injected as a user message when the model is about to give its final answer
 * (i.e., returns no tool calls after gathering context).
 */
export function buildSynthesisReminder(originalQuestion: string): string {
  return [
    `[IMPORTANT — ANSWER THE QUESTION]`,
    '',
    `The user's original question was: "${originalQuestion}"`,
    '',
    'Based on ALL the code you examined, answer this specific question directly.',
    '',
    'Your answer MUST:',
    '1. Directly address what the user asked — do NOT just describe code',
    '2. Reference specific files, line numbers, and code snippets',
    '3. If the user asked "where" or "how", give specific locations and steps',
    '4. If the user asked about adding/changing something, explain what files to modify and how',
    '',
    'Your answer MUST NOT:',
    '- Describe irrelevant code that doesn\'t answer the question',
    '- Be a generic overview of the project',
    '- Repeat tool output verbatim',
    '',
    'Format your answer in clean, readable Markdown.',
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
 *
 * @param text          The model's answer text
 * @param hadToolCalls  Whether the model used tools (stricter validation if so)
 * @param originalQuestion  Optional: the user's original question for relevance checking
 */
export function validateAnswer(
  text: string,
  hadToolCalls: boolean,
  originalQuestion?: string,
): ValidationResult {
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

  // Relevance check: does the answer relate to the original question?
  if (originalQuestion && hadToolCalls && trimmed.length > 50) {
    const relevance = checkAnswerRelevance(originalQuestion, trimmed);
    if (!relevance.relevant) {
      return { valid: false, reason: relevance.reason };
    }
  }

  return { valid: true };
}

// Stop words to ignore in relevance checking
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'not', 'only', 'own', 'same',
  'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and', 'or',
  'if', 'while', 'about', 'this', 'that', 'these', 'those', 'what',
  'which', 'who', 'whom', 'its', 'it', 'you', 'your', 'we', 'our',
  'they', 'their', 'i', 'me', 'my', 'change', 'adding', 'using', 'make',
]);

/**
 * Basic relevance check: extract key terms from the question and see
 * if the answer mentions at least some of them (or related code concepts).
 */
function checkAnswerRelevance(
  question: string,
  answer: string,
): { relevant: boolean; reason: string } {
  const questionTerms = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  if (questionTerms.length === 0) return { relevant: true, reason: '' };

  const answerLower = answer.toLowerCase();

  // Check how many question terms appear in the answer
  const mentioned = questionTerms.filter(term => answerLower.includes(term));
  const ratio = mentioned.length / questionTerms.length;

  // If less than 20% of key terms from the question appear in the answer,
  // it's likely off-topic
  if (ratio < 0.15 && questionTerms.length >= 2) {
    return {
      relevant: false,
      reason: `Your answer does not appear to address the user's question about "${questionTerms.join(', ')}". Re-read the question and provide a specific, relevant answer.`,
    };
  }

  return { relevant: true, reason: '' };
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

/**
 * Format the search plan text as a visually distinct block.
 * Uses dim blue with a left-border character (│) to set it apart from tool output.
 */
export function formatPlanBlock(planText: string, noColor: boolean): string {
  const lines = planText.split('\n');
  if (noColor) {
    return lines.map(l => `  │ ${l}`).join('\n');
  }
  return lines
    .map(l => `  ${ansi(ANSI.dimBlue, '│')} ${ansi(ANSI.dimBlue, l)}`)
    .join('\n');
}

/** Format an internal status message (compaction, critic, scratchpad, etc). Very dim. */
export function formatInternalStatus(message: string, noColor: boolean): string {
  if (noColor) {
    return `    · ${message}`;
  }
  return `    ${ansi(ANSI.dimGray, '·')} ${ansi(ANSI.dimGray + ANSI.italic, message)}`;
}

/** Format a tool call for display — dim cyan to stay visually secondary. */
export function formatToolCall(name: string, args: Record<string, unknown>, noColor: boolean): string {
  if (noColor) {
    return `    ▸ ${name}(${Object.entries(args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')})`;
  }
  const formattedArgs = Object.entries(args)
    .map(([k, v]) => `${ansi(ANSI.gray, k)}${ansi(ANSI.dimGray, '=')}${ansi(ANSI.dimYellow, JSON.stringify(v))}`)
    .join(ansi(ANSI.dimGray, ', '));
  return `    ${ansi(ANSI.dimCyan, '▸')} ${ansi(ANSI.dimCyan, name)}${ansi(ANSI.dimGray, '(')}${formattedArgs}${ansi(ANSI.dimGray, ')')}`;
}

/** Format a tool result summary for display — very dim, background-level. */
export function formatToolResult(output: string, noColor: boolean): string {
  const maxLen = 200;
  const preview = output.replace(/\n/g, ' ↵ ').slice(0, maxLen);
  const truncated = output.length > maxLen ? '…' : '';
  if (noColor) {
    return `      → ${preview}${truncated}`;
  }
  return `      ${ansi(ANSI.dimGreen, '→')} ${ansi(ANSI.dimGray, preview + truncated)}`;
}

/** Print a section separator — bold accent to clearly demarcate phases. */
export function formatSeparator(label: string, noColor: boolean): string {
  const line = '─'.repeat(Math.max(0, 60 - label.length - 2));
  if (noColor) {
    return `\n── ${label} ${line}\n`;
  }
  return `\n${ansi(ANSI.dim, '──')} ${ansi(ANSI.bold + ANSI.magenta, label)} ${ansi(ANSI.dim, line)}\n`;
}

/** Format a duplicate skip message — dim red. */
export function formatDuplicateSkip(name: string, noColor: boolean): string {
  if (noColor) {
    return `    ✕ skipped duplicate: ${name}`;
  }
  return `    ${ansi(ANSI.dim + ANSI.red, '✕')} ${ansi(ANSI.dimGray, `skipped duplicate: ${name}`)}`;
}

/** Format a retry/validation message — dim yellow, secondary prominence. */
export function formatRetry(message: string, noColor: boolean): string {
  if (noColor) {
    return `    ⟳ ${message}`;
  }
  return `    ${ansi(ANSI.dimYellow, '⟳')} ${ansi(ANSI.dimGray + ANSI.italic, message)}`;
}

/** Format a correction hint injection message. */
export function formatHintInjection(noColor: boolean): string {
  if (noColor) {
    return `    ⚠ injecting search guidance…`;
  }
  return `    ${ansi(ANSI.dimYellow, '⚠')} ${ansi(ANSI.dimGray + ANSI.italic, 'injecting search guidance…')}`;
}

/** Format usage stats — small dim footer. */
export function formatUsage(
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
  noColor: boolean,
): string {
  const str = `tokens: ${promptTokens} prompt + ${completionTokens} completion = ${totalTokens} total`;
  return noColor ? str : ansi(ANSI.dimGray, str);
}
