import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
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
  generateExecutionPlan,
  enrichUserPromptWithPlan,
  formatExecutionPlanBlock,
  StepVerifier,
  buildToolResultsSummary,
  buildSynthesisReminder,
  formatToolCall,
  formatToolResult,
  formatSeparator,
  formatDuplicateSkip,
  formatHintInjection,
  formatUsage,
  formatPlanBlock,
  formatInternalStatus,
  type ExecutionPlan,
} from '../utils/agent.js';
import { WorkingMemory } from '../utils/memory.js';
import { ToolResultCache } from '../utils/cache.js';
import { criticEvaluate, buildCriticCorrection } from '../utils/critic.js';
import { searchPastSessions, formatPastExchanges } from '../utils/past-sessions.js';
import { getOrBuildIndex, searchSymbols, formatSymbolResults } from '../utils/index-builder.js';
import { updateContextWithUsage } from '../utils/context.js';
import type { CliOverrides } from '../config/schema.js';
import type { Message } from '../providers/base.js';

export interface RunOptions extends CliOverrides {
  noColor?: boolean;
  quiet?: boolean;
  /** Auto-approve all write tool calls without prompting. */
  yes?: boolean;
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
    const stderrLog = options.quiet ? (_msg: string) => {} : (msg: string) => process.stderr.write(msg);
    const workspaceRoot = await getWorkspaceRoot();
    const rawConfig = await loadConfig(process.cwd(), options);
    const config = options.yes ? { ...rawConfig, toolPolicy: 'always' as const } : rawConfig;
    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    stderrLog(`Starting task: ${instruction}\n`);
    stderrLog(`Provider: ${profile.provider}, Model: ${profile.model ?? 'default'}\n`);

    // Load project context
    const { jamContext, workspaceCtx } = await loadProjectContext(workspaceRoot);

    const systemPrompt =
      profile.systemPrompt ??
      buildSystemPrompt(jamContext, workspaceCtx, { mode: 'readwrite', workspaceRoot });

    const memory = new WorkingMemory(adapter, profile.model, systemPrompt);
    const cache = new ToolResultCache();

    // ── Symbol index + past sessions ──────────────────────────────────────
    let symbolHint = '';
    try {
      const index = await getOrBuildIndex(workspaceRoot);
      const symbols = searchSymbols(index, instruction, 10);
      symbolHint = formatSymbolResults(symbols);
    } catch { /* non-fatal */ }

    let pastContext = '';
    try {
      const pastExchanges = await searchPastSessions(instruction, workspaceRoot, 2);
      pastContext = formatPastExchanges(pastExchanges);
    } catch { /* non-fatal */ }

    // ── Planning phase ─────────────────────────────────────────────────────
    stderrLog(formatSeparator('Planning', noColor));
    const projectCtxForPlan = [jamContext ?? workspaceCtx, symbolHint, pastContext].filter(Boolean).join('\n\n');

    let structuredPlan: ExecutionPlan | null = null;
    let enrichedInstruction: string;

    structuredPlan = await generateExecutionPlan(adapter, instruction, projectCtxForPlan, {
      model: profile.model,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      mode: 'readwrite',
    });

    if (structuredPlan) {
      stderrLog(formatExecutionPlanBlock(structuredPlan, noColor) + '\n');
      enrichedInstruction = enrichUserPromptWithPlan(instruction, structuredPlan);
    } else {
      const searchPlan = await generateSearchPlan(adapter, instruction, projectCtxForPlan, {
        model: profile.model,
        temperature: profile.temperature,
        maxTokens: profile.maxTokens,
      });
      if (searchPlan) {
        stderrLog(formatPlanBlock(searchPlan, noColor) + '\n');
      } else {
        stderrLog(formatInternalStatus('planning skipped — using generic strategy', noColor) + '\n');
      }
      enrichedInstruction = enrichUserPrompt(instruction, searchPlan);
    }

    let messages: Message[] = [
      { role: 'user', content: enrichedInstruction },
    ];

    const tracker = new ToolCallTracker();
    let currentStepIdx = 0;
    // Track which files have been read — used to enforce read-before-write
    const readFiles = new Set<string>();
    // Track original line counts of files that were auto-read before write
    const originalLineCounts = new Map<string, number>();
    const stepVerifier = new StepVerifier();

    if (!adapter.chatWithTools) {
      await printError('Provider does not support tool calling. Use a provider/model that supports tools.');
      process.exit(1);
    }

    /** Render final markdown result + usage stats. */
    const renderResult = async (text: string, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }) => {
      stderrLog(formatSeparator('Result', noColor));
      if (text) {
        try {
          const rendered = await renderMarkdown(text);
          process.stdout.write(rendered);
        } catch {
          process.stdout.write(text + '\n');
        }
      }
      if (usage) {
        stderrLog(`\n${formatUsage(usage.promptTokens, usage.completionTokens, usage.totalTokens, noColor)}\n`);
      }
      const log = memory.getAccessLog();
      updateContextWithUsage(workspaceRoot, log.readFiles, log.searchQueries).catch(() => {});
    };

    // Agentic loop
    const MAX_ITERATIONS = 15;
    let synthesisInjected = false;
    stderrLog(formatSeparator('Working', noColor));

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      // ── Step injection: remind model of current plan step every 3 rounds ──
      if (structuredPlan && iteration > 0 && iteration % 3 === 0 && currentStepIdx < structuredPlan.steps.length) {
        const step = structuredPlan.steps[currentStepIdx]!;
        messages.push({
          role: 'user',
          content: `[STEP REMINDER — Step ${step.id} of ${structuredPlan.steps.length}: ${step.action}. Use tool \`${step.tool}\` with args \`${JSON.stringify(step.args)}\`. Done when: ${step.successCriteria}]`,
        });
      }

      // ── Verifier: check progress every 3 rounds after ≥2 tool calls ────────
      if (iteration > 0 && iteration % 3 === 0 && tracker.totalCalls >= 2) {
        stderrLog(formatInternalStatus('Verifying progress…', noColor) + '\n');
        const summary = buildToolResultsSummary(messages);
        const vResult = await stepVerifier.verify(adapter, instruction, structuredPlan, summary, { model: profile.model });

        if (vResult.status === 'ready-to-answer') {
          stderrLog(formatInternalStatus('Verifier: sufficient context — synthesizing result', noColor) + '\n');
          if (!synthesisInjected) {
            synthesisInjected = true;
            messages.push({ role: 'user', content: buildSynthesisReminder(instruction) });
          }
        } else if (vResult.status === 'stuck') {
          stderrLog(formatInternalStatus(`Verifier: stuck — ${vResult.reason}`, noColor) + '\n');
          const nextStep = structuredPlan?.steps.find(s => s.id === vResult.nextStepId);
          const stuckHint = [
            `[VERIFIER: You appear stuck. ${vResult.reason}`,
            nextStep
              ? `Focus on Step ${nextStep.id}: use \`${nextStep.tool}\` with args \`${JSON.stringify(nextStep.args)}\`.`
              : 'Try list_dir to explore directories, then read concrete files.',
            ']',
          ].join(' ');
          messages.push({ role: 'user', content: stuckHint });
        }
      }

      // ── Context window management ──────────────────────────────────────────
      if (memory.shouldCompact(messages)) {
        stderrLog(formatInternalStatus('Compacting context…', noColor) + '\n');
        messages = await memory.compact(messages);
      }

      const response = await adapter.chatWithTools(messages, ALL_TOOL_SCHEMAS, {
        model: profile.model,
        temperature: profile.temperature,
        maxTokens: profile.maxTokens,
        systemPrompt,
      });

      // No tool calls → model is done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        const finalText = response.content ?? '';

        // ── Write-enforcement gate ────────────────────────────────────────────────
        // If there are write steps in the plan that haven't been executed yet,
        // the model has hallucinated Markdown instead of calling write_file.
        // Inject a hard correction to force actual tool use.
        const pendingWriteStep = structuredPlan?.steps
          .slice(currentStepIdx)
          .find(s => s.tool === 'write_file' || s.tool === 'apply_patch');

        if (pendingWriteStep && iteration < MAX_ITERATIONS - 2) {
          stderrLog(formatInternalStatus(`Write-enforcement: model skipped write_file — forcing retry on Step ${pendingWriteStep.id}`, noColor) + '\n');
          messages.push({ role: 'assistant', content: finalText });
          messages.push({
            role: 'user',
            content: [
              `[WRITE ENFORCEMENT] You output Markdown code blocks but did NOT call \`write_file\`. Code blocks do nothing — they do not create files.`,
              ``,
              `You MUST now call the \`write_file\` tool to complete Step ${pendingWriteStep.id}:`,
              `  Action: ${pendingWriteStep.action}`,
              `  Tool: \`write_file\``,
              `  Path: \`${(pendingWriteStep.args as Record<string, string>)['path'] ?? 'the target file'}\``,
              ``,
              `IMPORTANT: Use the ACTUAL file content based on the files you already read. Do NOT hardcode version strings, use require() calls, or placeholder values.`,
              `- Read the real file patterns from the files you already read in previous steps.`,
              `- For version: import it from package.json using a standard ESM import or createRequire — do NOT hardcode it.`,
              `- The function/export structure MUST match the pattern used in this project's existing commands.`,
              ``,
              `Call \`write_file\` now with the COMPLETE file content. Do NOT output any more Markdown.`,
            ].join('\n'),
          });
          continue;
        }

        // ── Generic write-mode enforcement (no structured plan) ───────────────────
        // If the model produced only Markdown code blocks without calling write_file,
        // force it to use tools instead. Pivot the message based on what's been done.
        const looksLikeHallucinatedCode = /```(?:typescript|ts|javascript|js)\n/.test(finalText);
        if (looksLikeHallucinatedCode && !tracker.wasToolCalled('write_file') && iteration < MAX_ITERATIONS - 2) {
          stderrLog(formatInternalStatus('Write-enforcement: Markdown-only response — forcing tool use', noColor) + '\n');
          messages.push({ role: 'assistant', content: finalText });
          const alreadyReadRef = tracker.wasToolCalled('read_file');
          if (!alreadyReadRef) {
            messages.push({
              role: 'user',
              content: [
                `[WRITE ENFORCEMENT] You output Markdown code blocks but did NOT call any tools. Code blocks do nothing.`,
                ``,
                `Step 1: Call \`read_file\` on src/commands/ask.ts to learn the export pattern.`,
                `Step 2: Call \`read_file\` on src/index.ts to see how commands are registered.`,
                `Step 3: Call \`write_file\` to create/modify every file needed for this task.`,
                ``,
                `Start now: call \`read_file\` with path "src/commands/ask.ts".`,
              ].join('\n'),
            });
          } else {
            messages.push({
              role: 'user',
              content: [
                `[WRITE ENFORCEMENT] You have already read the reference files. Now you MUST call \`write_file\` to complete the task.`,
                ``,
                `Original task: "${instruction}"`,
                ``,
                `You must call \`write_file\` for EACH file mentioned in the task. Use the COMPLETE file content based on what you read — no placeholder stubs, no hardcoded versions.`,
                ``,
                `Call \`write_file\` right now. Do NOT output any Markdown.`,
              ].join('\n'),
            });
          }
          continue;
        }

        // ── Write-completion check (replaces critic for write tasks) ───────────────
        // In write mode, "done" means all write steps were executed, not a text answer.
        const hasWritePlan = structuredPlan?.steps.some(s => s.tool === 'write_file' || s.tool === 'apply_patch');
        if (hasWritePlan) {
          const allWritesDone = !structuredPlan?.steps
            .slice(currentStepIdx)
            .some(s => s.tool === 'write_file' || s.tool === 'apply_patch');
          if (allWritesDone) {
            await renderResult(finalText || '✓ All write steps completed.', response.usage);
            break;
          }
          // writes remain — write-enforcement above should handle it, but if we reach here just continue
          messages.push({ role: 'assistant', content: finalText });
          messages.push({ role: 'user', content: `Continue executing the remaining steps of the execution plan. Next: Step ${currentStepIdx + 1}.` });
          continue;
        }

        // Synthesis grounding with critic (read-only tasks only)
        if (tracker.totalCalls > 0 && !synthesisInjected && iteration < MAX_ITERATIONS - 2) {
          synthesisInjected = true;
          if (finalText.trim().length > 0) {
            stderrLog(formatInternalStatus('Evaluating result quality…', noColor) + '\n');
            const verdict = await criticEvaluate(adapter, instruction, finalText, { model: profile.model });
            if (verdict.pass) {
              await renderResult(finalText, response.usage);
              break;
            }
            stderrLog(formatInternalStatus(`Critic: ${verdict.reason}`, noColor) + '\n');
            messages.push({ role: 'assistant', content: finalText });
            const stepHint = structuredPlan && currentStepIdx < structuredPlan.steps.length
              ? `\n\nResume execution plan at Step ${structuredPlan.steps[currentStepIdx]!.id}: ${structuredPlan.steps[currentStepIdx]!.action}.`
              : '';
            messages.push({ role: 'user', content: buildCriticCorrection(verdict, instruction) + stepHint });
            continue;
          }
          stderrLog(formatInternalStatus('Grounding answer to instruction…', noColor) + '\n');
          messages.push({ role: 'assistant', content: finalText });
          messages.push({ role: 'user', content: buildSynthesisReminder(instruction) });
          continue;
        }

        // Final critic check
        if (tracker.totalCalls > 0 && finalText.trim().length > 30 && iteration < MAX_ITERATIONS - 2) {
          const verdict = await criticEvaluate(adapter, instruction, finalText, { model: profile.model });
          if (!verdict.pass) {
            stderrLog(formatInternalStatus(`Critic: ${verdict.reason}`, noColor) + '\n');
            messages.push({ role: 'assistant', content: finalText });
            const stepHint = structuredPlan && currentStepIdx < structuredPlan.steps.length
              ? `\n\nResume execution plan at Step ${structuredPlan.steps[currentStepIdx]!.id}.`
              : '';
            messages.push({ role: 'user', content: buildCriticCorrection(verdict, instruction) + stepHint });
            continue;
          }
        }

        await renderResult(finalText, response.usage);
        break;
      }

      // Advance plan step if executor used the planned tool
      if (structuredPlan && currentStepIdx < structuredPlan.steps.length && response.toolCalls?.length) {
        const expectedTool = structuredPlan.steps[currentStepIdx]!.tool;
        if (response.toolCalls.some(tc => tc.name === expectedTool)) {
          currentStepIdx++;
        }
      }

      // Track files read this iteration (for read-before-write gate)
      for (const tc of response.toolCalls ?? []) {
        if (tc.name === 'read_file' && typeof tc.arguments['path'] === 'string') {
          readFiles.add(tc.arguments['path']);
        }
      }

      // Add assistant message to conversation
      messages.push({ role: 'assistant', content: response.content ?? '' });

      // Print any intermediate text
      if (response.content) {
        stderrLog(`\n${response.content}\n`);
      }

      // Execute tool calls
      for (const tc of response.toolCalls) {
        // Duplicate detection
        if (tracker.isDuplicate(tc.name, tc.arguments)) {
          stderrLog(formatDuplicateSkip(tc.name, noColor) + '\n');
          messages.push({
            role: 'user',
            content: `[Tool result: ${tc.name}]\nYou already made this exact call. Try a DIFFERENT approach.`,
          });
          tracker.record(tc.name, tc.arguments, true);
          continue;
        }

        const isReadonly = READONLY_TOOL_NAMES.has(tc.name);

        // Check cache for read-only tools
        if (isReadonly) {
          const cached = cache.get(tc.name, tc.arguments);
          if (cached !== null) {
            stderrLog(formatToolCall(tc.name, tc.arguments, noColor) + ' (cached)\n');
            const capped = memory.processToolResult(tc.name, tc.arguments, cached);
            messages.push({ role: 'user', content: `[Tool result: ${tc.name}]\n${capped}` });
            tracker.record(tc.name, tc.arguments, false);
            continue;
          }
        }

        stderrLog(formatToolCall(tc.name, tc.arguments, noColor) + '\n');

        // ── Read-before-write gate ─────────────────────────────────────────
        // Block write operations if the target file hasn't been read yet.
        // This prevents the model from overwriting files it hasn't inspected.
        if (!isReadonly && tc.name !== 'run_command') {
          const targetPath = typeof tc.arguments['path'] === 'string' ? tc.arguments['path'] : null;
          if (targetPath && !readFiles.has(targetPath)) {
            // Auto-read the file first
            stderrLog(formatInternalStatus(`Read-before-write: reading ${targetPath} first…`, noColor) + '\n');
            try {
              const { executeReadOnlyTool } = await import('../tools/context-tools.js');
              const existing = await executeReadOnlyTool('read_file', { path: targetPath }, workspaceRoot);
              readFiles.add(targetPath);
              const lineCount = existing.split('\n').length;
              const capped = memory.processToolResult('read_file', { path: targetPath }, existing);
              originalLineCounts.set(targetPath, lineCount);
              messages.push({
                role: 'user',
                content: [
                  `[Auto-read before write] Current content of ${targetPath} (${lineCount} lines):`,
                  capped,
                  ``,
                  `⚠️  CRITICAL WRITE RULE: The current file is ${lineCount} lines. Your \`write_file\` call MUST include ALL of the original content PLUS your additions. Do NOT write a stub or drop any existing code. The new file should be LONGER than the original.`,
                ].join('\n'),
              });
            } catch {
              // File doesn't exist yet (new file) — that's fine, proceed
            }
          }
        }

        // Confirm write tools based on policy
        if (!isReadonly) {
          if (config.toolPolicy === 'never') {
            const msg = `Tool "${tc.name}" is a write tool and policy is set to "never"`;
            await printWarning(msg);
            messages.push({ role: 'user', content: `[Tool result: ${tc.name}]\nDenied: ${msg}` });
            tracker.record(tc.name, tc.arguments, true);
            continue;
          }
          // 'always' — auto-approve all writes without prompting
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

        // Cache read-only results
        if (!wasError && isReadonly) cache.set(tc.name, tc.arguments, toolOutput);
        // Invalidate cache on write operations
        if (!isReadonly && tc.arguments['path']) {
          cache.invalidatePath(String(tc.arguments['path']));
        }

        // Cap tool output before injecting into messages
        const cappedOutput = memory.processToolResult(tc.name, tc.arguments, toolOutput);

        // ── Post-write shrinkage guard ─────────────────────────────────
        // If a write_file replaced an existing file with something suspiciously small,
        // auto-restore it from git and inject an error to redirect the model.
        if (
          !wasError &&
          tc.name === 'write_file' &&
          typeof tc.arguments['path'] === 'string'
        ) {
          const writtenPath = tc.arguments['path'];
          const origLines = originalLineCounts.get(writtenPath);
          if (origLines && origLines > 10) {
            try {
              const { readFile: fsReadFile } = await import('node:fs/promises');
              const newContent = await fsReadFile(join(workspaceRoot, writtenPath), 'utf8');
              const newLines = newContent.split('\n').length;
              // If new file is less than 40% of original, it's a stub — restore
              if (newLines < origLines * 0.4) {
                stderrLog(formatInternalStatus(
                  `Write guard: ${writtenPath} shrank from ${origLines} to ${newLines} lines — restoring from git`,
                  noColor,
                ) + '\n');
                const { execSync } = await import('node:child_process');
                execSync(`git checkout -- "${writtenPath}"`, { cwd: workspaceRoot });
                messages.push({
                  role: 'user',
                  content: [
                    `[WRITE GUARD] Your write_file call for \`${writtenPath}\` dropped ${origLines - newLines} lines and was automatically reverted.`,
                    ``,
                    `The original file had ${origLines} lines. You wrote only ${newLines} lines — that's a stub.`,
                    `You MUST write the COMPLETE file: all original code PLUS your additions.`,
                    `Read the auto-injected content above that was prepended before your write and use it as the base. Do NOT omit any existing code.`,
                  ].join('\n'),
                });
                break; // exit inner tool loop; outer loop will re-run with correction
              }
            } catch { /* non-fatal */ }
          }
        }

        stderrLog(formatToolResult(cappedOutput, noColor) + '\n');
        tracker.record(tc.name, tc.arguments, wasError);
        messages.push({ role: 'user', content: `[Tool result: ${tc.name}]\n${cappedOutput}` });
      }

      // Scratchpad checkpoint
      if (memory.shouldScratchpad(iteration)) {
        stderrLog(formatInternalStatus('Working memory checkpoint…', noColor) + '\n');
        messages.push(memory.scratchpadPrompt());
      }

      // Inject correction hints if stuck
      const hint = tracker.getCorrectionHint();
      if (hint) {
        stderrLog(formatHintInjection(noColor) + '\n');
        messages.push({ role: 'user', content: hint });
      }
    }

    stderrLog('\nTask complete.\n');
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message);
    process.exit(1);
  }
}
