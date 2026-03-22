import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CopilotClientOptions } from '@github/copilot-sdk';
import type {
  ProviderAdapter,
  ProviderInfo,
  CompletionRequest,
  StreamChunk,
  Message,
  ToolDefinition,
  ToolCall,
  ChatWithToolsResponse,
} from './base.js';
import { JamError } from '../utils/errors.js';

const execFileAsync = promisify(execFile);

// Local interface types matching the subset of @github/copilot-sdk we use.
// Avoids strict-mode lint errors from the SDK's broad types.
interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  ping(message: string): Promise<unknown>;
  createSession(config: Record<string, unknown>): Promise<CopilotSessionLike>;
  listModels(): Promise<Array<{ id: string; name?: string }>>;
}

interface CopilotSessionLike {
  send(options: { prompt: string }): void;
  sendAndWait(
    options: { prompt: string },
    timeout?: number
  ): Promise<{ data?: { content?: string } } | undefined>;
  disconnect(): Promise<void>;
  on(event: string, handler: (event: Record<string, unknown>) => void): void;
}

/**
 * Resolve a GitHub token for Copilot SDK authentication.
 * Priority: explicit apiKey → GITHUB_TOKEN env → gh auth token → undefined
 */
async function resolveGithubToken(apiKey?: string): Promise<string | undefined> {
  if (apiKey && apiKey !== 'unused') return apiKey;
  if (process.env['GITHUB_TOKEN']) return process.env['GITHUB_TOKEN'];

  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 5000 });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // gh CLI not available or not authenticated
  }

  return undefined;
}

/**
 * Check if @github/copilot CLI is available on the system.
 */
export async function isCopilotCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync('npx', ['@github/copilot', '--version'], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

interface SdkBackendOptions {
  apiKey?: string;
  model?: string;
  requestTimeoutMs?: number;
}

export class CopilotSdkBackend implements ProviderAdapter {
  readonly info: ProviderInfo = {
    name: 'copilot',
    supportsStreaming: true,
    supportsTools: true,
  };

  private client: CopilotClientLike | null = null;
  private readonly options: SdkBackendOptions;

  constructor(options: SdkBackendOptions = {}) {
    this.options = options;
  }

  async validateCredentials(): Promise<void> {
    try {
      const { CopilotClient } = await import('@github/copilot-sdk');
      const token = await resolveGithubToken(this.options.apiKey);

      const clientOptions: Record<string, unknown> = {
        autoStart: false,
      };
      if (token) {
        clientOptions['githubToken'] = token;
        clientOptions['useLoggedInUser'] = false;
      } else {
        clientOptions['useLoggedInUser'] = true;
      }

      this.client = new CopilotClient(clientOptions as CopilotClientOptions) as unknown as CopilotClientLike;

      await this.client.start();
      await this.client.ping('jam-cli');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes('auth') || message.includes('token') || message.includes('unauthorized')) {
        throw new JamError(
          'Copilot authentication failed. Set GITHUB_TOKEN env var, run `gh auth login`, or set apiKey in your jam profile.',
          'PROVIDER_AUTH_FAILED',
          { retryable: false, cause: err }
        );
      }

      throw new JamError(
        `Failed to connect to Copilot: ${message}`,
        'PROVIDER_UNAVAILABLE',
        { retryable: false, cause: err }
      );
    }
  }

  async *streamCompletion(request: CompletionRequest): AsyncIterable<StreamChunk> {
    if (!this.client) {
      throw new JamError('Client not initialized. Call validateCredentials() first.', 'PROVIDER_UNAVAILABLE');
    }

    const { approveAll } = await import('@github/copilot-sdk');

    const sessionConfig: Record<string, unknown> = {
      onPermissionRequest: approveAll,
      streaming: true,
    };
    if (this.options.model || request.model) {
      sessionConfig['model'] = request.model ?? this.options.model;
    }
    if (request.systemPrompt) {
      sessionConfig['systemMessage'] = { mode: 'append' as const, content: request.systemPrompt };
    }

    const session = await this.client.createSession(sessionConfig);

    const prompt = formatMessages(request.messages);

    // Use an async queue to bridge SDK events to the async generator
    const queue: Array<StreamChunk | null> = [];
    let resolve: (() => void) | null = null;

    function enqueue(chunk: StreamChunk | null): void {
      queue.push(chunk);
      if (resolve) {
        resolve();
        resolve = null;
      }
    }

    function waitForNext(): Promise<void> {
      if (queue.length > 0) return Promise.resolve();
      return new Promise<void>((r) => { resolve = r; });
    }

    session.on('assistant.message_delta', (event: Record<string, unknown>) => {
      const data = event['data'] as Record<string, unknown> | undefined;
      const content = typeof data?.['deltaContent'] === 'string' ? data['deltaContent'] : '';
      if (content) {
        enqueue({ delta: content, done: false });
      }
    });

    session.on('session.idle', () => {
      enqueue(null); // Signal end
    });

    // Send the message (fire and forget — events will stream in)
    session.send({ prompt });

    // Yield chunks as they arrive
    while (true) {
      await waitForNext();
      while (queue.length > 0) {
        const chunk = queue.shift()!;
        if (chunk === null) {
          yield { delta: '', done: true };
          await session.disconnect();
          return;
        }
        yield chunk;
      }
    }
  }

  async chatWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    options?: { model?: string; temperature?: number; maxTokens?: number; systemPrompt?: string }
  ): Promise<ChatWithToolsResponse> {
    if (!this.client) {
      throw new JamError('Client not initialized.', 'PROVIDER_UNAVAILABLE');
    }

    const { approveAll } = await import('@github/copilot-sdk');

    // Build a tool-description block for the system prompt so the model
    // knows which tools are available and returns tool calls in JSON.
    const toolBlock = tools.length > 0
      ? '\n\nAvailable tools (call ONE tool per response using JSON):\n' +
        tools.map(t =>
          `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters)}`
        ).join('\n') +
        '\n\nTo call a tool, respond with ONLY a JSON object:\n' +
        '{"tool":"<tool_name>","arguments":{...}}\n' +
        'Do NOT wrap in markdown. Do NOT add any text before or after the JSON.'
      : '';

    const sessionConfig: Record<string, unknown> = {
      onPermissionRequest: approveAll,
      streaming: false,
    };
    if (options?.model || this.options.model) {
      sessionConfig['model'] = options?.model ?? this.options.model;
    }
    if (options?.systemPrompt) {
      sessionConfig['systemMessage'] = {
        mode: 'append' as const,
        content: options.systemPrompt + toolBlock,
      };
    } else if (toolBlock) {
      sessionConfig['systemMessage'] = {
        mode: 'append' as const,
        content: toolBlock,
      };
    }

    const session = await this.client.createSession(sessionConfig);
    const prompt = formatMessages(messages);

    const result = await session.sendAndWait(
      { prompt },
      this.options.requestTimeoutMs ?? 120_000
    );

    let content: string | null = null;
    if (result) {
      content = result.data?.content ?? null;
    }

    await session.disconnect();

    // Try to parse tool calls from the model's response
    const toolCalls = content ? parseToolCalls(content) : undefined;
    if (toolCalls) {
      // If we parsed tool calls, clear the content so the caller
      // knows this is a tool-call response, not a text response.
      return { content: null, toolCalls };
    }

    return { content, toolCalls: undefined };
  }

  async listModels(): Promise<string[]> {
    if (!this.client) {
      throw new JamError('Client not initialized.', 'PROVIDER_UNAVAILABLE');
    }

    try {
      const models = await this.client.listModels();
      return (models ?? []).map((m) => m.id ?? m.name).filter(Boolean).sort();
    } catch (err) {
      throw new JamError(
        'Failed to list Copilot models.',
        'PROVIDER_UNAVAILABLE',
        { retryable: false, cause: err }
      );
    }
  }

  dispose(): void {
    if (this.client) {
      // client.stop() is async but dispose() is sync — fire and forget
      try {
        void this.client.stop();
      } catch {
        // Best effort cleanup
      }
      this.client = null;
    }
  }
}

/**
 * Format jam messages into a single prompt string for the SDK.
 * System messages are handled via sessionConfig.systemMessage, so
 * they are included here only as fallback context.
 */
function formatMessages(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      parts.push(`[System] ${msg.content}`);
    } else if (msg.role === 'assistant') {
      parts.push(`[Assistant] ${msg.content}`);
    } else {
      parts.push(msg.content);
    }
  }
  return parts.join('\n\n');
}

/**
 * Parse tool calls from model text output.
 * The model is instructed to respond with JSON: {"tool":"name","arguments":{...}}
 */
function parseToolCalls(text: string): ToolCall[] | undefined {
  // Try to find JSON tool call in the response
  const jsonMatch = text.match(/\{[\s\S]*?"tool"\s*:\s*"[\s\S]*?\}/);
  if (!jsonMatch) return undefined;

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { tool?: string; arguments?: Record<string, unknown> };
    if (parsed.tool && typeof parsed.tool === 'string') {
      return [{
        id: `call_${Date.now()}`,
        name: parsed.tool,
        arguments: (parsed.arguments ?? {}) as Record<string, unknown>,
      }];
    }
  } catch {
    // Not valid JSON
  }

  return undefined;
}
