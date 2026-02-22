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
  validateAnswer,
  buildCorrectionMessage,
  formatToolCall,
  formatToolResult,
  formatSeparator,
  formatDuplicateSkip,
  formatRetry,
  formatHintInjection,
  formatUsage,
} from '../utils/agent.js';
import type { CliOverrides } from '../config/schema.js';
import type { Message } from '../providers/base.js';

export interface AskOptions extends CliOverrides {
  file?: string;
  json?: boolean;
  noColor?: boolean;
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
    process.stderr.write(`\n${formatUsage(u.promptTokens, u.completionTokens, u.totalTokens, noColor)}\n`);
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
      typeof adapter.chatWithTools === 'function';

    // Build workspace context for better model reasoning
    const workspaceRoot = useTools ? await getWorkspaceRoot() : '';
    const { jamContext, workspaceCtx } = useTools
      ? await loadProjectContext(workspaceRoot)
      : { jamContext: null, workspaceCtx: '' };

    const systemPrompt =
      options.system ??
      profile.systemPrompt ??
      (useTools ? buildSystemPrompt(jamContext, workspaceCtx) : undefined);

    if (useTools && adapter.chatWithTools) {
      const noColor = options.noColor ?? false;
      const tracker = new ToolCallTracker();

      // ── Planning phase: deep reasoning about what to search for ─────────
      process.stderr.write(formatSeparator('Planning', noColor));
      const projectCtxForPlan = jamContext ?? workspaceCtx;
      const searchPlan = await generateSearchPlan(adapter, prompt, projectCtxForPlan, {
        model: profile.model,
        temperature: profile.temperature,
        maxTokens: profile.maxTokens,
      });

      if (searchPlan) {
        process.stderr.write(searchPlan + '\n');
      } else {
        process.stderr.write('  (planning skipped — using generic search strategy)\n');
      }

      // Enrich the user's prompt with the search plan
      const enrichedPrompt = enrichUserPrompt(prompt, searchPlan);
      const messages: Message[] = [{ role: 'user', content: enrichedPrompt }];

      const MAX_TOOL_ROUNDS = 15;
      let synthesisInjected = false;

      process.stderr.write(formatSeparator('Searching codebase', noColor));

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
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
          // If we gathered context (tool calls made) but haven't injected
          // a synthesis reminder yet, do so now and ask for one more round.
          if (tracker.totalCalls > 0 && !synthesisInjected && round < MAX_TOOL_ROUNDS - 2) {
            synthesisInjected = true;
            const synthesisOk = finalText.trim().length > 0;

            // If the model already produced an answer, validate it first
            if (synthesisOk) {
              const validation = validateAnswer(finalText, true, prompt);
              if (validation.valid) {
                // Answer looks good — render it
                process.stderr.write(formatSeparator('Answer', noColor));
                await renderFinalAnswer(finalText, response.usage, options, profile, noColor);
                return;
              }
            }

            // Inject synthesis reminder and retry
            process.stderr.write(formatRetry('Grounding answer to your question…', noColor) + '\n');
            messages.push({ role: 'assistant', content: finalText });
            messages.push({ role: 'user', content: buildSynthesisReminder(prompt) });
            continue;
          }

          // ── Self-validation: check if the answer looks like garbage ──
          const validation = validateAnswer(finalText, tracker.totalCalls > 0, prompt);

          if (!validation.valid && round < MAX_TOOL_ROUNDS - 2) {
            process.stderr.write(formatRetry('Answer quality check failed, retrying…', noColor) + '\n');
            messages.push({ role: 'assistant', content: finalText });
            messages.push({ role: 'user', content: buildCorrectionMessage(validation.reason!) });
            continue;
          }

          process.stderr.write(formatSeparator('Answer', noColor));
          await renderFinalAnswer(finalText, response.usage, options, profile, noColor);
          return;
        }

        // ── Execute tool calls ────────────────────────────────────────────────
        messages.push({ role: 'assistant', content: response.content ?? '' });

        for (const tc of response.toolCalls) {
          // Duplicate detection — skip and inject guidance
          if (tracker.isDuplicate(tc.name, tc.arguments)) {
            process.stderr.write(formatDuplicateSkip(tc.name, noColor) + '\n');
            messages.push({
              role: 'user',
              content: `[Tool result: ${tc.name}]\nYou already made this exact call. The result was the same as before. Try a DIFFERENT search query or tool.`,
            });
            tracker.record(tc.name, tc.arguments, true);
            continue;
          }

          process.stderr.write(formatToolCall(tc.name, tc.arguments, noColor) + '\n');

          let toolOutput: string;
          let wasError = false;
          try {
            toolOutput = await executeReadOnlyTool(tc.name, tc.arguments, workspaceRoot);
          } catch (err) {
            toolOutput = `Tool error: ${JamError.fromUnknown(err).message}`;
            wasError = true;
          }

          process.stderr.write(formatToolResult(toolOutput, noColor) + '\n');
          tracker.record(tc.name, tc.arguments, wasError);

          messages.push({ role: 'user', content: `[Tool result: ${tc.name}]\n${toolOutput}` });
        }

        // ── Inject correction hints if stuck ──────────────────────────────────
        const hint = tracker.getCorrectionHint();
        if (hint) {
          process.stderr.write(formatHintInjection(noColor) + '\n');
          messages.push({ role: 'user', content: hint });
        }
      }

      // Exceeded round limit — fall through to streaming
      process.stderr.write(formatSeparator('Max tool rounds reached, generating answer', noColor));
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
