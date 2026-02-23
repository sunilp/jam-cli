import { readFile } from 'node:fs/promises';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { withRetry, collectStream } from '../utils/stream.js';
import { streamToStdout, printJsonResult, printError, renderMarkdown } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import { READ_ONLY_TOOL_SCHEMAS, executeReadOnlyTool } from '../tools/context-tools.js';
import {
  ToolCallTracker,
  loadProjectContext,
  buildSystemPrompt,
  enrichUserPrompt,
  generateSearchPlan,
  buildSynthesisReminder,
  formatToolCall,
  formatToolResult,
  formatSeparator,
  formatDuplicateSkip,
  formatHintInjection,
  formatUsage,
  formatPlanBlock,
  formatInternalStatus,
} from '../utils/agent.js';
import { WorkingMemory } from '../utils/memory.js';
import { ToolResultCache } from '../utils/cache.js';
import { criticEvaluate, buildCriticCorrection } from '../utils/critic.js';
import { searchPastSessions, formatPastExchanges } from '../utils/past-sessions.js';
import { getOrBuildIndex, searchSymbols, formatSymbolResults } from '../utils/index-builder.js';
import { updateContextWithUsage } from '../utils/context.js';
import type { CliOverrides } from '../config/schema.js';
import type { Message } from '../providers/base.js';

export interface AskOptions extends CliOverrides {
  file?: string;
  json?: boolean;
  noColor?: boolean;
  quiet?: boolean;
  system?: string;
  /** Enable read-only tool use so the model can discover and read files.
   *  Defaults to true when stdout is a TTY and the provider supports chatWithTools. */
  tools?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readPromptFromStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').trim()));
    process.stdin.on('error', reject);
  });
}

// ── Main command ──────────────────────────────────────────────────────────────

/** Render the final answer (shared by tool-loop exit and synthesis). */
async function renderFinalAnswer(
  text: string,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined,
  options: AskOptions,
  profile: { model?: string },
  noColor: boolean,
  stderrLog: (msg: string) => void,
): Promise<void> {
  if (options.json) {
    printJsonResult({ response: text, usage, model: profile.model });
  } else {
    try {
      const rendered = await renderMarkdown(text);
      process.stdout.write(rendered);
    } catch {
      process.stdout.write(text + '\n');
    }
  }

  if (usage && !options.json) {
    const u = usage;
    stderrLog(`\n${formatUsage(u.promptTokens, u.completionTokens, u.totalTokens, noColor)}\n`);
  }
}

export async function runAsk(inlinePrompt: string | undefined, options: AskOptions): Promise<void> {
  try {
    // Resolve prompt from file, inline arg, or stdin (priority order)
    let prompt: string;

    if (options.file) {
      try {
        prompt = (await readFile(options.file, 'utf-8')).trim();
      } catch (err) {
        throw new JamError(
          `Cannot read file: ${options.file}`,
          'INPUT_FILE_NOT_FOUND',
          { cause: err }
        );
      }
    } else if (inlinePrompt) {
      prompt = inlinePrompt;
    } else {
      const stdinContent = await readPromptFromStdin();
      if (!stdinContent) {
        throw new JamError(
          'No prompt provided. Pass a question as an argument, pipe from stdin, or use --file.',
          'INPUT_MISSING'
        );
      }
      prompt = stdinContent;
    }

    if (options.noColor) {
      const chalk = await import('chalk');
      chalk.default.level = 0;
    }

    // Quiet mode: suppress all non-essential stderr output
    const stderrLog = options.quiet ? (_msg: string) => {} : (msg: string) => process.stderr.write(msg);

    // Load config with CLI overrides
    const cliOverrides: CliOverrides = {
      profile: options.profile,
      provider: options.provider,
      model: options.model,
      baseUrl: options.baseUrl,
    };
    const config = await loadConfig(process.cwd(), cliOverrides);
    const profile = getActiveProfile(config);

    // Create provider
    const adapter = await createProvider(profile);

    // ── Agentic context-gathering phase ───────────────────────────────────────
    const useTools =
      options.tools !== false &&
      adapter.info.supportsTools !== false &&
      typeof adapter.chatWithTools === 'function';

    // Build workspace context for better model reasoning
    const workspaceRoot = useTools ? await getWorkspaceRoot() : '';
    const { jamContext, workspaceCtx } = useTools
      ? await loadProjectContext(workspaceRoot)
      : { jamContext: null, workspaceCtx: '' };

    const systemPrompt =
      options.system ??
      profile.systemPrompt ??
      (useTools
        ? buildSystemPrompt(jamContext, workspaceCtx)
        : adapter.info.supportsTools === false
          // Embedded / small model: lean prompt — just answer the question.
          ? 'You are a helpful, knowledgeable AI assistant. Answer the user\'s question directly, concisely, and accurately. Format your response in clean Markdown when helpful.'
          : undefined);

    if (useTools && adapter.chatWithTools) {
      const noColor = options.noColor ?? false;
      const tracker = new ToolCallTracker();
      const memory = new WorkingMemory(adapter, profile.model, systemPrompt);
      const cache = new ToolResultCache();

      // ── Symbol index: pre-load for planner enrichment ───────────────────
      let symbolHint = '';
      try {
        const index = await getOrBuildIndex(workspaceRoot);
        const symbols = searchSymbols(index, prompt, 10);
        symbolHint = formatSymbolResults(symbols);
      } catch { /* non-fatal */ }

      // ── Past sessions: find relevant prior Q&A ──────────────────────────
      let pastContext = '';
      try {
        const pastExchanges = await searchPastSessions(prompt, workspaceRoot, 2);
        pastContext = formatPastExchanges(pastExchanges);
      } catch { /* non-fatal */ }

      // ── Planning phase: deep reasoning about what to search for ─────────
      stderrLog(formatSeparator('Planning', noColor));
      const projectCtxForPlan = [jamContext ?? workspaceCtx, symbolHint, pastContext].filter(Boolean).join('\n\n');
      const searchPlan = await generateSearchPlan(adapter, prompt, projectCtxForPlan, {
        model: profile.model,
        temperature: profile.temperature,
        maxTokens: profile.maxTokens,
      });

      if (searchPlan) {
        stderrLog(formatPlanBlock(searchPlan, noColor) + '\n');
      } else {
        stderrLog(formatInternalStatus('planning skipped — using generic search strategy', noColor) + '\n');
      }

      // Enrich the user's prompt with the search plan
      const enrichedPrompt = enrichUserPrompt(prompt, searchPlan);
      let messages: Message[] = [{ role: 'user', content: enrichedPrompt }];

      const MAX_TOOL_ROUNDS = 15;
      let synthesisInjected = false;

      stderrLog(formatSeparator('Searching codebase', noColor));

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        // ── Context window management: compact if approaching limit ───────
        if (memory.shouldCompact(messages)) {
          stderrLog(formatInternalStatus('Compacting context…', noColor) + '\n');
          messages = await memory.compact(messages);
        }

        const response = await adapter.chatWithTools(messages, READ_ONLY_TOOL_SCHEMAS, {
          model: profile.model,
          temperature: profile.temperature,
          maxTokens: profile.maxTokens,
          systemPrompt,
        });

        // No tool calls → model is ready to answer
        if (!response.toolCalls || response.toolCalls.length === 0) {
          const finalText = response.content ?? '';

          // ── Synthesis grounding: remind model of the original question ───
          if (tracker.totalCalls > 0 && !synthesisInjected && round < MAX_TOOL_ROUNDS - 2) {
            synthesisInjected = true;

            // If the model already produced an answer, run critic evaluation
            if (finalText.trim().length > 0) {
              stderrLog(formatInternalStatus('Evaluating answer quality…', noColor) + '\n');
              const verdict = await criticEvaluate(adapter, prompt, finalText, { model: profile.model });
              if (verdict.pass) {
                stderrLog(formatSeparator('Answer', noColor));
                await renderFinalAnswer(finalText, response.usage, options, profile, noColor, stderrLog);
                // Auto-update JAM.md with usage patterns
                const log = memory.getAccessLog();
                updateContextWithUsage(workspaceRoot, log.readFiles, log.searchQueries).catch(() => {});
                return;
              }
              // Critic rejected — use its specific feedback
              stderrLog(formatInternalStatus(`Critic: ${verdict.reason}`, noColor) + '\n');
              messages.push({ role: 'assistant', content: finalText });
              messages.push({ role: 'user', content: buildCriticCorrection(verdict, prompt) });
              continue;
            }

            // No answer yet — inject synthesis reminder
            stderrLog(formatInternalStatus('Grounding answer to your question…', noColor) + '\n');
            messages.push({ role: 'assistant', content: finalText });
            messages.push({ role: 'user', content: buildSynthesisReminder(prompt) });
            continue;
          }

          // ── Final critic check ──────────────────────────────────────────
          if (tracker.totalCalls > 0 && finalText.trim().length > 30 && round < MAX_TOOL_ROUNDS - 2) {
            const verdict = await criticEvaluate(adapter, prompt, finalText, { model: profile.model });
            if (!verdict.pass) {
              stderrLog(formatInternalStatus(`Critic: ${verdict.reason}`, noColor) + '\n');
              messages.push({ role: 'assistant', content: finalText });
              messages.push({ role: 'user', content: buildCriticCorrection(verdict, prompt) });
              continue;
            }
          }

          stderrLog(formatSeparator('Answer', noColor));
          await renderFinalAnswer(finalText, response.usage, options, profile, noColor, stderrLog);
          // Auto-update JAM.md with usage patterns
          const log = memory.getAccessLog();
          updateContextWithUsage(workspaceRoot, log.readFiles, log.searchQueries).catch(() => {});
          return;
        }

        // ── Execute tool calls ────────────────────────────────────────────────
        messages.push({ role: 'assistant', content: response.content ?? '' });

        for (const tc of response.toolCalls) {
          // Duplicate detection — skip and inject guidance
          if (tracker.isDuplicate(tc.name, tc.arguments)) {
            stderrLog(formatDuplicateSkip(tc.name, noColor) + '\n');
            messages.push({
              role: 'user',
              content: `[Tool result: ${tc.name}]\nYou already made this exact call. The result was the same as before. Try a DIFFERENT search query or tool.`,
            });
            tracker.record(tc.name, tc.arguments, true);
            continue;
          }

          // Check cache first
          const cached = cache.get(tc.name, tc.arguments);
          if (cached !== null) {
            stderrLog(formatToolCall(tc.name, tc.arguments, noColor) + ' (cached)\n');
            const capped = memory.processToolResult(tc.name, tc.arguments, cached);
            messages.push({ role: 'user', content: `[Tool result: ${tc.name}]\n${capped}` });
            tracker.record(tc.name, tc.arguments, false);
            continue;
          }

          stderrLog(formatToolCall(tc.name, tc.arguments, noColor) + '\n');

          let toolOutput: string;
          let wasError = false;
          try {
            toolOutput = await executeReadOnlyTool(tc.name, tc.arguments, workspaceRoot);
          } catch (err) {
            toolOutput = `Tool error: ${JamError.fromUnknown(err).message}`;
            wasError = true;
          }

          // Cache the result
          if (!wasError) cache.set(tc.name, tc.arguments, toolOutput);

          // Cap the output before injecting into messages
          const cappedOutput = memory.processToolResult(tc.name, tc.arguments, toolOutput);

          stderrLog(formatToolResult(cappedOutput, noColor) + '\n');
          tracker.record(tc.name, tc.arguments, wasError);

          messages.push({ role: 'user', content: `[Tool result: ${tc.name}]\n${cappedOutput}` });
        }

        // ── Scratchpad: periodic working memory checkpoint ─────────────────
        if (memory.shouldScratchpad(round)) {
          stderrLog(formatInternalStatus('Working memory checkpoint…', noColor) + '\n');
          messages.push(memory.scratchpadPrompt());
        }

        // ── Inject correction hints if stuck ──────────────────────────────────
        const hint = tracker.getCorrectionHint();
        if (hint) {
          stderrLog(formatHintInjection(noColor) + '\n');
          messages.push({ role: 'user', content: hint });
        }
      }

      // Exceeded round limit — fall through to streaming
      stderrLog(formatSeparator('Max tool rounds reached, generating answer', noColor));
    }

    // ── Standard streaming response ───────────────────────────────────────────
    const request = {
      messages: [{ role: 'user' as const, content: prompt }],
      model: profile.model,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      systemPrompt,
    };

    if (options.json) {
      const stream = withRetry(() => adapter.streamCompletion(request));
      const { text, usage } = await collectStream(stream);
      printJsonResult({ response: text, usage, model: profile.model });
    } else {
      const stream = withRetry(() => adapter.streamCompletion(request));
      await streamToStdout(stream);
    }
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message);
    process.exit(1);
  }
}
