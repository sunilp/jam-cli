import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ProviderAdapter,
  ProviderInfo,
  CompletionRequest,
  StreamChunk,
  Message,
  ToolDefinition,
  ChatWithToolsResponse,
} from './base.js';
import { JamError } from '../utils/errors.js';

const execFileAsync = promisify(execFile);

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

  private client: any = null;
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

      this.client = new CopilotClient(clientOptions as any);

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

    session.on('assistant.message_delta', (event: any) => {
      const content = event?.data?.deltaContent ?? '';
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

    // Import jam's tool execution function
    const { executeTool } = await import('../tools/all-tools.js');
    const cwd = process.cwd();

    // Map jam tool definitions to SDK tools with real execution handlers
    const sdkTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
      handler: async (args: Record<string, unknown>) => {
        try {
          const result = await executeTool(t.name, args, cwd);
          return { textResultForLlm: result, resultType: 'success' as const };
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          return { textResultForLlm: `Error: ${errMessage}`, resultType: 'failure' as const };
        }
      },
    }));

    const sessionConfig: Record<string, unknown> = {
      onPermissionRequest: approveAll,
      tools: sdkTools,
      streaming: false,
    };
    if (options?.model || this.options.model) {
      sessionConfig['model'] = options?.model ?? this.options.model;
    }
    if (options?.systemPrompt) {
      sessionConfig['systemMessage'] = { mode: 'append' as const, content: options.systemPrompt };
    }

    const session = await this.client.createSession(sessionConfig);

    const prompt = formatMessages(messages);

    // sendAndWait returns AssistantMessageEvent | undefined
    const result = await session.sendAndWait(
      { prompt },
      this.options.requestTimeoutMs ?? 120_000
    );

    // AssistantMessageEvent has shape: { type: "assistant.message", data: { content: string, ... } }
    let content: string | null = null;
    if (result) {
      content = result.data?.content ?? null;
    }

    await session.disconnect();

    // All tools already executed by SDK — no pending tool calls
    return { content, toolCalls: undefined };
  }

  async listModels(): Promise<string[]> {
    if (!this.client) {
      throw new JamError('Client not initialized.', 'PROVIDER_UNAVAILABLE');
    }

    try {
      const models = await this.client.listModels();
      return (models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean).sort();
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
