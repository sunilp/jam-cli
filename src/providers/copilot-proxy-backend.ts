import type { ProviderInfo } from './base.js';
import { OpenAIAdapter } from './openai.js';
import { JamError } from '../utils/errors.js';
import { proxyFetch } from '../utils/fetch.js';

/**
 * CopilotProxyBackend — talks to the local HTTP proxy server started by the jam-vscode extension,
 * which bridges vscode.lm (Copilot) as an OpenAI-compatible endpoint.
 *
 * This is the concrete backend used by CopilotAdapter when routing to the VSCode proxy.
 */
export class CopilotProxyBackend extends OpenAIAdapter {
  override readonly info: ProviderInfo = {
    name: 'copilot',
    supportsStreaming: true,
    supportsTools: true,
  };

  constructor(options: { baseUrl: string; model?: string; requestTimeoutMs?: number; tlsCaPath?: string }) {
    super({
      baseUrl: options.baseUrl,
      model: options.model ?? 'copilot',
      apiKey: 'unused', // Prevent parent constructor from reading OPENAI_API_KEY
      requestTimeoutMs: options.requestTimeoutMs,
      tlsCaPath: options.tlsCaPath,
    });
  }

  protected override authHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json' };
  }

  override async validateCredentials(): Promise<void> {
    try {
      const response = await proxyFetch(`${this.baseUrl}/health`, {}, this.fetchOptions);
      if (!response.ok) {
        throw new Error(`Health check returned ${response.status}`);
      }
    } catch (err) {
      if (err instanceof JamError) throw err;
      throw new JamError(
        'Copilot LM server not reachable. Open a new terminal in VSCode or use --provider ollama',
        'PROVIDER_UNAVAILABLE',
        { retryable: false, cause: err }
      );
    }
  }

  override async listModels(): Promise<string[]> {
    try {
      const response = await proxyFetch(`${this.baseUrl}/v1/models`, {
        headers: this.authHeaders(),
      }, { ...this.fetchOptions, timeoutMs: this.fetchOptions.timeoutMs ?? 10_000 });

      if (!response.ok) {
        throw new Error(`Models endpoint returned ${response.status}`);
      }

      const data = (await response.json()) as { data: Array<{ id: string }> };
      return (data.data ?? []).map((m) => m.id).sort();
    } catch (err) {
      if (err instanceof JamError) throw err;
      throw new JamError(
        'Copilot LM server not reachable. Open a new terminal in VSCode or use --provider ollama',
        'PROVIDER_UNAVAILABLE',
        { retryable: false, cause: err }
      );
    }
  }

  dispose(): void {}
}
