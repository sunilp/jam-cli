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
 * 1. CopilotProxyBackend — VSCode proxy (preferred: fast HTTP, native tool calling)
 * 2. CopilotSdkBackend — Copilot CLI fallback (slower: session-based)
 *
 * The proxy is preferred because it uses fast HTTP round-trips, making it
 * suitable for multi-turn agentic loops (jam run, jam go). The SDK backend
 * starts a new session per call (~2s overhead) which is fine for one-shot
 * commands but too slow for 10-25 iteration loops.
 */
export class CopilotAdapter implements ProviderAdapter {
  private backend: ProviderAdapter | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly options: CopilotAdapterOptions;

  constructor(options: CopilotAdapterOptions = {}) {
    this.options = options;
  }

  get info(): ProviderInfo {
    if (this.backend) return this.backend.info;
    return { name: 'copilot', supportsStreaming: true, supportsTools: true };
  }

  /**
   * Lazily initialize the backend on first use.
   * Safe to call multiple times — only runs once.
   */
  private async ensureBackend(): Promise<void> {
    if (this.backend) return;
    if (!this.initPromise) {
      this.initPromise = this.validateCredentials();
    }
    await this.initPromise;
  }

  async validateCredentials(): Promise<void> {
    // Try proxy backend first (fast HTTP, preferred for agentic loops)
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
        // Proxy not available, fall through to SDK
      }
    }

    // Try SDK backend (slower but works outside VSCode)
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
      // SDK also failed
    }

    // Neither backend available
    throw new JamError(
      'Copilot provider not available.\n' +
      '  Option 1: Open a terminal in VSCode with the Jam extension installed (recommended).\n' +
      '  Option 2: Install Copilot CLI: npm install -g @github/copilot\n' +
      '  Option 3: Use a different provider: --provider ollama',
      'PROVIDER_UNAVAILABLE'
    );
  }

  async *streamCompletion(request: CompletionRequest): AsyncIterable<StreamChunk> {
    await this.ensureBackend();
    yield* this.backend!.streamCompletion(request);
  }

  async chatWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    options?: { model?: string; temperature?: number; maxTokens?: number; systemPrompt?: string }
  ): Promise<ChatWithToolsResponse> {
    await this.ensureBackend();
    return this.backend!.chatWithTools!(messages, tools, options);
  }

  async listModels(): Promise<string[]> {
    await this.ensureBackend();
    return this.backend!.listModels();
  }

  dispose(): void {
    if (this.backend?.dispose) {
      this.backend.dispose();
    }
    this.backend = null;
  }
}
