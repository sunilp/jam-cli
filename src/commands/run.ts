import { createInterface } from 'node:readline/promises';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { printError, printWarning, renderMarkdown } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import { ALL_TOOL_SCHEMAS, READONLY_TOOL_NAMES, executeTool } from '../tools/all-tools.js';
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
import type { CliOverrides, ToolPolicy } from '../config/schema.js';
import type { Message } from '../providers/base.js';

export interface RunOptions extends CliOverrides {
  noColor?: boolean;
}

async function confirmToolCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<boolean> {
  process.stderr.write(`\n[Tool Request] ${toolName}\n`);
  process.stderr.write(`Arguments: ${JSON.stringify(args, null, 2)}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question('Allow this tool call? [y/N] ');
  rl.close();
  return answer.toLowerCase() === 'y';
}

export async function runRun(instruction: string | undefined, options: RunOptions): Promise<void> {
  if (!instruction) {
    await printError('Provide an instruction. Usage: jam run "<instruction>"');
    process.exit(1);
  }

  try {
    const noColor = options.noColor ?? false;
    const workspaceRoot = await getWorkspaceRoot();
    const config = await loadConfig(process.cwd(), options);
    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    process.stderr.write(`Starting task: ${instruction}\n`);
    process.stderr.write(`Provider: ${profile.provider}, Model: ${profile.model ?? 'default'}\n`);

    // Load project context
    const { jamContext, workspaceCtx } = await loadProjectContext(workspaceRoot);

    const systemPrompt =
      profile.systemPrompt ??
      buildSystemPrompt(jamContext, workspaceCtx, { mode: 'readwrite', workspaceRoot });

    // ── Planning phase ────────────────────────────────────────────────────
    process.stderr.write(formatSeparator('Planning', noColor));
    const projectCtxForPlan = jamContext ?? workspaceCtx;
    const searchPlan = await generateSearchPlan(adapter, instruction, projectCtxForPlan, {
      model: profile.model,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
    });

    if (searchPlan) {
      process.stderr.write(searchPlan + '\n');
    } else {
      process.stderr.write('  (planning skipped — using generic strategy)\n');
    }

    // Enrich the instruction with the search plan
    const enrichedInstruction = enrichUserPrompt(instruction, searchPlan);

    const messages: Message[] = [
      { role: 'user', content: enrichedInstruction },
    ];

    const tracker = new ToolCallTracker();

    if (!adapter.chatWithTools) {
      await printError('Provider does not support tool calling. Use a provider/model that supports tools.');
      process.exit(1);
    }

    // Agentic loop
    const MAX_ITERATIONS = 15;
    let synthesisInjected = false;
    process.stderr.write(formatSeparator('Working', noColor));

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const response = await adapter.chatWithTools(messages, ALL_TOOL_SCHEMAS, {
        model: profile.model,
        temperature: profile.temperature,
        maxTokens: profile.maxTokens,
        systemPrompt,
      });

      // No tool calls → model is done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        const finalText = response.content ?? '';

        // Synthesis grounding
        if (tracker.totalCalls > 0 && !synthesisInjected && iteration < MAX_ITERATIONS - 2) {
          synthesisInjected = true;
          if (finalText.trim().length > 0) {
            const validation = validateAnswer(finalText, true, instruction);
            if (validation.valid) {
              // Answer is already good
              process.stderr.write(formatSeparator('Result', noColor));
              if (finalText) {
                try {
                  const rendered = await renderMarkdown(finalText);
                  process.stdout.write(rendered);
                } catch {
                  process.stdout.write(finalText + '\n');
                }
              }
              if (response.usage) {
                const u = response.usage;
                process.stderr.write(`\n${formatUsage(u.promptTokens, u.completionTokens, u.totalTokens, noColor)}\n`);
              }
              break;
            }
          }
          process.stderr.write(formatRetry('Grounding answer to your question…', noColor) + '\n');
          messages.push({ role: 'assistant', content: finalText });
          messages.push({ role: 'user', content: buildSynthesisReminder(instruction) });
          continue;
        }

        // Self-validation
        const validation = validateAnswer(finalText, tracker.totalCalls > 0, instruction);
        if (!validation.valid && iteration < MAX_ITERATIONS - 2) {
          process.stderr.write(formatRetry('Answer quality check failed, retrying…', noColor) + '\n');
          messages.push({ role: 'assistant', content: finalText });
          messages.push({ role: 'user', content: buildCorrectionMessage(validation.reason!) });
          continue;
        }

        process.stderr.write(formatSeparator('Result', noColor));

        // Render as markdown
        if (finalText) {
          try {
            const rendered = await renderMarkdown(finalText);
            process.stdout.write(rendered);
          } catch {
            process.stdout.write(finalText + '\n');
          }
        }

        if (response.usage) {
          const u = response.usage;
          process.stderr.write(`\n${formatUsage(u.promptTokens, u.completionTokens, u.totalTokens, noColor)}\n`);
        }
        break;
      }

      // Add assistant message to conversation
      messages.push({ role: 'assistant', content: response.content ?? '' });

      // Print any intermediate text
      if (response.content) {
        process.stderr.write(`\n${response.content}\n`);
      }

      // Execute tool calls
      for (const tc of response.toolCalls) {
        // Duplicate detection
        if (tracker.isDuplicate(tc.name, tc.arguments)) {
          process.stderr.write(formatDuplicateSkip(tc.name, noColor) + '\n');
          messages.push({
            role: 'user',
            content: `[Tool result: ${tc.name}]\nYou already made this exact call. Try a DIFFERENT approach.`,
          });
          tracker.record(tc.name, tc.arguments, true);
          continue;
        }

        const isReadonly = READONLY_TOOL_NAMES.has(tc.name);
        process.stderr.write(formatToolCall(tc.name, tc.arguments, noColor) + '\n');

        // Confirm write tools based on policy
        if (!isReadonly) {
          if (config.toolPolicy === 'never') {
            const msg = `Tool "${tc.name}" is a write tool and policy is set to "never"`;
            await printWarning(msg);
            messages.push({ role: 'user', content: `[Tool result: ${tc.name}]\nDenied: ${msg}` });
            tracker.record(tc.name, tc.arguments, true);
            continue;
          }
          if (config.toolPolicy === 'ask_every_time') {
            const allowed = await confirmToolCall(tc.name, tc.arguments);
            if (!allowed) {
              messages.push({ role: 'user', content: `[Tool result: ${tc.name}]\nDenied by user.` });
              tracker.record(tc.name, tc.arguments, true);
              continue;
            }
          }
        }

        let toolOutput: string;
        let wasError = false;
        try {
          toolOutput = await executeTool(tc.name, tc.arguments, workspaceRoot);
        } catch (err) {
          const jamErr = JamError.fromUnknown(err);
          toolOutput = `Tool error: ${jamErr.message}`;
          wasError = true;
        }

        process.stderr.write(formatToolResult(toolOutput, noColor) + '\n');
        tracker.record(tc.name, tc.arguments, wasError);
        messages.push({ role: 'user', content: `[Tool result: ${tc.name}]\n${toolOutput}` });
      }

      // Inject correction hints if stuck
      const hint = tracker.getCorrectionHint();
      if (hint) {
        process.stderr.write(formatHintInjection(noColor) + '\n');
        messages.push({ role: 'user', content: hint });
      }
    }

    process.stderr.write('\nTask complete.\n');
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message);
    process.exit(1);
  }
}
