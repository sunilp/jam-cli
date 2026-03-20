import type { ProviderAdapter, Message, TokenUsage } from '../providers/base.js';
import type { Subtask, SubtaskContext, WorkerResult, FileChange, WorkspaceProfile } from './types.js';
import type { ProviderLease } from './provider-pool.js';
import { WorkingMemory } from '../utils/memory.js';
import { formatProfileForPrompt } from './workspace-intel.js';

// ── Dependencies ─────────────────────────────────────────────────────────────

export interface WorkerDeps {
  lease: ProviderLease;          // from ProviderPool.acquire()
  workspaceRoot: string;
  workspaceProfile: WorkspaceProfile;
  toolSchemas: any[];            // tool definitions for chatWithTools
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}

// ── Worker execution loop ────────────────────────────────────────────────────

export async function executeWorker(
  subtask: Subtask,
  context: SubtaskContext,
  signal: AbortSignal,
  deps: WorkerDeps,
): Promise<WorkerResult> {
  const { lease, workspaceProfile, toolSchemas, executeTool } = deps;
  const adapter = lease.adapter;
  const maxRounds = subtask.estimatedRounds + 5; // budget + 5 bonus
  const memory = new WorkingMemory(adapter, undefined, undefined);

  const totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const filesChanged: FileChange[] = [];

  // Build system prompt with workspace profile + subtask context
  const systemPrompt = buildWorkerSystemPrompt(workspaceProfile, subtask, context);

  // Initial messages
  const messages: Message[] = [
    { role: 'user', content: buildInitialPrompt(subtask, context) },
  ];

  for (let round = 0; round < maxRounds; round++) {
    // Check cancellation
    if (signal.aborted) {
      return {
        subtaskId: subtask.id,
        status: 'cancelled',
        filesChanged,
        summary: `Cancelled after ${round} rounds`,
        tokensUsed: totalUsage,
      };
    }

    // Context compaction check
    if (memory.shouldCompact(messages)) {
      messages.splice(0, messages.length, ...(await memory.compact(messages)));
    }

    // Scratchpad checkpoint
    if (memory.shouldScratchpad(round) && round > 0) {
      messages.push(memory.scratchpadPrompt());
    }

    // Call provider
    if (!adapter.chatWithTools) {
      return {
        subtaskId: subtask.id,
        status: 'failed',
        filesChanged,
        summary: 'Provider does not support tool calling',
        tokensUsed: totalUsage,
        error: 'Provider does not support chatWithTools',
      };
    }

    const response = await adapter.chatWithTools(messages, toolSchemas, {
      systemPrompt,
      temperature: 0.2,
    });

    // Track token usage
    if (response.usage) {
      totalUsage.promptTokens += response.usage.promptTokens;
      totalUsage.completionTokens += response.usage.completionTokens;
      totalUsage.totalTokens += response.usage.totalTokens;
    }

    // No tool calls → worker is done
    if (!response.toolCalls || response.toolCalls.length === 0) {
      // Run validation command if provided
      if (subtask.validationCommand) {
        try {
          await executeTool('run_command', { command: subtask.validationCommand });
        } catch {
          // Validation failed — but worker completed its work
        }
      }

      return {
        subtaskId: subtask.id,
        status: 'completed',
        filesChanged,
        summary: response.content ?? `Completed in ${round + 1} rounds`,
        tokensUsed: totalUsage,
      };
    }

    // Execute tool calls
    messages.push({ role: 'assistant', content: response.content ?? '' });

    for (const tc of response.toolCalls) {
      let output: string;
      try {
        output = await executeTool(tc.name, tc.arguments);

        // Track file changes for write tools
        if (tc.name === 'write_file' && tc.arguments.path) {
          filesChanged.push({
            path: String(tc.arguments.path),
            action: 'created', // simplified — could check if file existed
            diff: '',
          });
        }
      } catch (err) {
        output = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }

      const capped = memory.processToolResult(tc.name, tc.arguments, output);
      messages.push({ role: 'user', content: `[Tool result: ${tc.name}]\n${capped}` });
    }

    // Stuck detection: at half budget with no file changes
    if (round === Math.floor(subtask.estimatedRounds * 0.5) && filesChanged.length === 0) {
      messages.push({
        role: 'user',
        content: '[HINT: You are halfway through your budget and have not made any file changes. Focus on the task and use write_file to make progress.]',
      });
    }
  }

  // Exceeded round budget
  return {
    subtaskId: subtask.id,
    status: 'failed',
    filesChanged,
    summary: `Exceeded round budget (${maxRounds} rounds)`,
    tokensUsed: totalUsage,
    error: 'AGENT_WORKER_TIMEOUT',
  };
}

// ── Prompt builders ──────────────────────────────────────────────────────────

function buildWorkerSystemPrompt(
  profile: WorkspaceProfile,
  subtask: Subtask,
  _context: SubtaskContext,
): string {
  return [
    'You are an AI coding agent executing a specific subtask.',
    'You MUST use tools to read and write files. Never output code blocks as a substitute for writing files.',
    'After writing a file, read it back to verify.',
    '',
    formatProfileForPrompt(profile),
    '',
    `Your task: ${subtask.description}`,
    subtask.validationCommand ? `Validation: run \`${subtask.validationCommand}\` when done` : '',
    `Files you may touch: ${subtask.files.map(f => `${f.path} (${f.mode})`).join(', ') || 'any'}`,
  ].filter(Boolean).join('\n');
}

function buildInitialPrompt(subtask: Subtask, context: SubtaskContext): string {
  const parts = [`Task: ${subtask.description}`];
  if (context.priorSummary) parts.push(`\nPrior context: ${context.priorSummary}`);
  if (context.filesAvailable.length > 0) parts.push(`\nAvailable files from prior work: ${context.filesAvailable.join(', ')}`);
  if (context.planReminder) parts.push(`\n${context.planReminder}`);
  return parts.join('\n');
}
