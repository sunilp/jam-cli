import { createInterface } from 'node:readline/promises';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { printError, printWarning } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import type { CliOverrides, ToolPolicy } from '../config/schema.js';
import type { Message } from '../providers/base.js';

export interface RunOptions extends CliOverrides {
  noColor?: boolean;
}

// Inline tool definitions for the run command (mirrors src/tools/ implementations)
const TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read the contents of a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace root' },
          start_line: { type: 'number', description: 'Start line (optional)' },
          end_line: { type: 'number', description: 'End line (optional)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_dir',
      description: 'List files and directories in a path',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Directory path (default: ".")' } },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_text',
      description: 'Search for text in the codebase using ripgrep',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (regex supported)' },
          glob: { type: 'string', description: 'File glob pattern (e.g. "*.ts")' },
          max_results: { type: 'number', description: 'Max results (default 20)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'git_status',
      description: 'Get current git status',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'git_diff',
      description: 'Get git diff',
      parameters: {
        type: 'object',
        properties: {
          staged: { type: 'boolean', description: 'Show staged changes' },
          path: { type: 'string', description: 'Limit to a specific path' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write content to a file (requires confirmation)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'File content' },
          mode: { type: 'string', description: '"overwrite" or "append" (default: overwrite)' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'apply_patch',
      description: 'Apply a unified diff patch (requires confirmation)',
      parameters: {
        type: 'object',
        properties: { patch: { type: 'string', description: 'Unified diff content' } },
        required: ['patch'],
      },
    },
  },
];

const READONLY_TOOLS = new Set(['read_file', 'list_dir', 'search_text', 'git_status', 'git_diff']);

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

async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
  policy: ToolPolicy
): Promise<string> {
  const isReadonly = READONLY_TOOLS.has(toolName);

  if (!isReadonly) {
    if (policy === 'never') {
      throw new JamError(
        `Tool "${toolName}" is a write tool and policy is set to "never"`,
        'TOOL_DENIED'
      );
    }
    if (policy === 'ask_every_time') {
      const allowed = await confirmToolCall(toolName, args);
      if (!allowed) {
        throw new JamError(`Tool "${toolName}" was denied by the user`, 'TOOL_DENIED');
      }
    }
  }

  // Lazy import the tool implementation from the tools layer
  const { createDefaultRegistry } = await import('../tools/registry.js');
  const registry = createDefaultRegistry();
  const result = await registry.get(toolName)?.execute(args, { workspaceRoot, cwd: process.cwd() });
  if (!result) {
    throw new JamError(`Unknown tool: ${toolName}`, 'TOOL_NOT_FOUND');
  }
  return result.error ? `Error: ${result.error}` : result.output;
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaMessage {
  role: string;
  content: string | null;
  tool_calls?: OllamaToolCall[];
}

export async function runRun(instruction: string | undefined, options: RunOptions): Promise<void> {
  if (!instruction) {
    await printError('Provide an instruction. Usage: jam run "<instruction>"');
    process.exit(1);
  }

  try {
    const workspaceRoot = await getWorkspaceRoot();
    const config = await loadConfig(process.cwd(), options);
    const profile = getActiveProfile(config);

    process.stderr.write(`Starting task: ${instruction}\n`);
    process.stderr.write(`Provider: ${profile.provider}, Model: ${profile.model ?? 'default'}\n\n`);

    const messages: Message[] = [
      {
        role: 'user',
        content: instruction,
      },
    ];

    const systemPrompt =
      profile.systemPrompt ??
      `You are a developer assistant with access to the local codebase. ` +
      `Use the provided tools to read files, search code, and make changes. ` +
      `Always validate your changes. Workspace root: ${workspaceRoot}`;

    // Agentic loop — up to 10 iterations
    const MAX_ITERATIONS = 10;
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const baseUrl = profile.baseUrl ?? 'http://localhost:11434';
      const model = profile.model ?? 'llama3.2';

      // Call Ollama with tools
      let response: Response;
      try {
        response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              ...messages.map((m) => ({ role: m.role, content: m.content })),
            ],
            tools: TOOL_SCHEMAS,
            stream: false,
          }),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        throw new JamError('Failed to connect to provider', 'PROVIDER_UNAVAILABLE', {
          cause: err,
          retryable: true,
        });
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new JamError(`Provider error ${response.status}: ${text}`, 'PROVIDER_STREAM_ERROR');
      }

      const data = (await response.json()) as { message: OllamaMessage; done: boolean };
      const assistantMsg = data.message;

      // Add assistant message to conversation
      messages.push({
        role: 'assistant',
        content: assistantMsg.content ?? '',
      });

      // Print any text content
      if (assistantMsg.content) {
        process.stdout.write('\n[Assistant]\n' + assistantMsg.content + '\n');
      }

      // Check for tool calls
      const toolCalls = assistantMsg.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // No tool calls — task is done
        break;
      }

      // Execute each tool call
      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const args = tc.function.arguments;

        process.stderr.write(`\n[Tool] ${toolName}(${JSON.stringify(args)})\n`);

        let toolOutput: string;
        try {
          toolOutput = await executeTool(toolName, args, workspaceRoot, config.toolPolicy);
          process.stderr.write(`[Result] ${toolOutput.slice(0, 200)}${toolOutput.length > 200 ? '...' : ''}\n`);
        } catch (err) {
          const jamErr = JamError.fromUnknown(err);
          if (jamErr.code === 'TOOL_DENIED') {
            toolOutput = `Tool call was denied: ${jamErr.message}`;
            await printWarning(jamErr.message);
          } else {
            toolOutput = `Tool execution failed: ${jamErr.message}`;
          }
        }

        // Add tool result to conversation as a user message
        messages.push({
          role: 'user',
          content: `[Tool result for ${toolName}]\n${toolOutput}`,
        });
      }
    }

    process.stderr.write('\nTask complete.\n');
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message);
    process.exit(1);
  }
}
