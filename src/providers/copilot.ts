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

interface CopilotAdapterOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  tlsCaPath?: string;
}

/**
 * Smart Copilot provider that dispatches to the best available backend:
 * 1. CopilotSdkBackend — full tool calling via @github/copilot-sdk
 * 2. CopilotProxyBackend — VSCode proxy fallback (no tool calling)
 */
export class CopilotAdapter implements ProviderAdapter {
  private backend: ProviderAdapter | null = null;
  private readonly options: CopilotAdapterOptions;

  constructor(options: CopilotAdapterOptions = {}) {
    this.options = options;
  }

  get info(): ProviderInfo {
    if (this.backend) return this.backend.info;
    return { name: 'copilot', supportsStreaming: true, supportsTools: false };
  }

  async validateCredentials(): Promise<void> {
    // Try SDK backend first
    try {
      const { isCopilotCliAvailable, CopilotSdkBackend } = await import('./copilot-sdk-backend.js');
      if (await isCopilotCliAvailable()) {
        const sdk = new CopilotSdkBackend({
          apiKey: this.options.apiKey,
          model: this.options.model,
          requestTimeoutMs: this.options.requestTimeoutMs,
        });

        await sdk.validateCredentials();
        this.backend = sdk;
        return;
      }
    } catch {
      // SDK failed, fall through to proxy
    }

    // Try proxy backend
    const port = process.env['JAM_VSCODE_LM_PORT'];
    const baseUrl = this.options.baseUrl ?? (port ? `http://127.0.0.1:${port}` : undefined);

    if (baseUrl) {
      try {
        const { CopilotProxyBackend } = await import('./copilot-proxy-backend.js');
        const proxy = new CopilotProxyBackend({
          baseUrl,
          model: this.options.model,
          requestTimeoutMs: this.options.requestTimeoutMs,
          tlsCaPath: this.options.tlsCaPath,
        });

        await proxy.validateCredentials();
        this.backend = proxy;
        return;
      } catch {
        // Proxy also failed
      }
    }

    // Neither backend available
    throw new JamError(
      'Copilot provider not available.\n' +
      '  Option 1: Install Copilot CLI: npm install -g @github/copilot\n' +
      '  Option 2: Open a terminal in VSCode with the Jam extension installed.\n' +
      '  Option 3: Use a different provider: --provider ollama',
      'PROVIDER_UNAVAILABLE'
    );
  }

  async *streamCompletion(request: CompletionRequest): AsyncIterable<StreamChunk> {
    if (!this.backend) throw new JamError('Not connected. Call validateCredentials() first.', 'PROVIDER_UNAVAILABLE');
    yield* this.backend.streamCompletion(request);
  }

  async chatWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    options?: { model?: string; temperature?: number; maxTokens?: number; systemPrompt?: string }
  ): Promise<ChatWithToolsResponse> {
    if (!this.backend) throw new JamError('Not connected.', 'PROVIDER_UNAVAILABLE');
    if (!this.backend.info.supportsTools) {
      throw new JamError(
        'Copilot proxy backend does not support tool calling. Install @github/copilot CLI for full support.',
        'PROVIDER_UNAVAILABLE'
      );
    }
    return this.backend.chatWithTools!(messages, tools, options);
  }

  async listModels(): Promise<string[]> {
    if (!this.backend) throw new JamError('Not connected.', 'PROVIDER_UNAVAILABLE');
    return this.backend.listModels();
  }

  dispose(): void {
    if (this.backend?.dispose) {
      this.backend.dispose();
    }
    this.backend = null;
  }
}
