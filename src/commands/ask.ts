import { readFile } from 'node:fs/promises';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { withRetry, collectStream } from '../utils/stream.js';
import { streamToStdout, printJsonResult, printError } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import type { CliOverrides } from '../config/schema.js';
import type { Message, ToolDefinition } from '../providers/base.js';

export interface AskOptions extends CliOverrides {
  file?: string;
  json?: boolean;
  noColor?: boolean;
  system?: string;
  /** Enable read-only tool use so the model can discover and read files.
   *  Defaults to true when stdout is a TTY and the provider supports chatWithTools. */
  tools?: boolean;
}

// ── Read-only tool schemas exposed to the model ───────────────────────────────

const READ_ONLY_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the workspace',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        start_line: { type: 'number', description: 'First line to read (1-based, optional)' },
        end_line: { type: 'number', description: 'Last line to read (inclusive, optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and sub-directories at a path in the workspace',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to workspace root (default: ".")' },
      },
      required: [],
    },
  },
  {
    name: 'search_text',
    description: 'Search for text patterns in the codebase using ripgrep',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (regex supported)' },
        glob: { type: 'string', description: 'File glob to restrict search (e.g. "*.ts")' },
        max_results: { type: 'number', description: 'Maximum number of results (default 20)' },
      },
      required: ['query'],
    },
  },
];

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
    // When the provider supports tool calling and tools are not explicitly
    // disabled, let the model read/search files before giving its final answer.
    const useTools =
      options.tools !== false &&
      typeof adapter.chatWithTools === 'function';

    const systemPrompt =
      options.system ??
      profile.systemPrompt ??
      (useTools
        ? 'You are a helpful developer assistant. You have read-only access to the ' +
          'local codebase via tools. Use them to find and read relevant files before ' +
          'answering. When you have gathered enough context, reply directly to the user.'
        : undefined);

    if (useTools && adapter.chatWithTools) {
      const workspaceRoot = await getWorkspaceRoot();
      const { createDefaultRegistry } = await import('../tools/registry.js');
      const registry = createDefaultRegistry();

      const messages: Message[] = [{ role: 'user', content: prompt }];
      const MAX_TOOL_ROUNDS = 8;

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const response = await adapter.chatWithTools(messages, READ_ONLY_TOOLS, {
          model: profile.model,
          temperature: profile.temperature,
          maxTokens: profile.maxTokens,
          systemPrompt,
        });

        // No tool calls → model is ready to answer; collect final text
        if (!response.toolCalls || response.toolCalls.length === 0) {
          const finalText = response.content ?? '';
          if (options.json) {
            printJsonResult({ response: finalText, usage: response.usage, model: profile.model });
          } else {
            process.stdout.write(finalText + '\n');
          }
          return;
        }

        // Add the assistant's (possibly empty) message to history
        messages.push({ role: 'assistant', content: response.content ?? '' });

        // Execute each tool call and feed results back
        for (const tc of response.toolCalls) {
          process.stderr.write(`[tool: ${tc.name}(${JSON.stringify(tc.arguments)})]\n`);
          let toolOutput: string;
          try {
            const tool = registry.get(tc.name);
            if (!tool) throw new JamError(`Unknown tool: ${tc.name}`, 'TOOL_NOT_FOUND');
            const result = await tool.execute(tc.arguments, {
              workspaceRoot,
              cwd: process.cwd(),
            });
            toolOutput = result.error ? `Error: ${result.error}` : result.output;
          } catch (err) {
            toolOutput = `Tool error: ${JamError.fromUnknown(err).message}`;
          }
          process.stderr.write(`[result: ${toolOutput.slice(0, 120)}${toolOutput.length > 120 ? '…' : ''}]\n`);
          messages.push({ role: 'user', content: `[Tool result: ${tc.name}]\n${toolOutput}` });
        }
      }

      // Exceeded round limit — do a final non-tool call
      messages.push({
        role: 'user',
        content: 'You have used the maximum number of tool calls. Please answer now based on what you have gathered.',
      });
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
