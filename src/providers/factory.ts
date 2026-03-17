import type { ProviderAdapter } from './base.js';
import type { Profile } from '../config/schema.js';
import { JamError } from '../utils/errors.js';

/**
 * Infer the provider from a model name when `--model` is passed without `--provider`.
 * Returns null if the model doesn't match a known pattern.
 */
export function inferProviderFromModel(model: string): string | null {
  const m = model.toLowerCase();

  // Anthropic / Claude models
  if (m.startsWith('claude-') || m.startsWith('claude_')) return 'anthropic';

  // OpenAI models
  if (m.startsWith('gpt-') || m.startsWith('o1-') || m.startsWith('o3-') || m.startsWith('o4-')) return 'openai';
  if (m === 'gpt4' || m === 'gpt3') return 'openai';
  if (m.startsWith('chatgpt-')) return 'openai';
  if (m.startsWith('dall-e') || m.startsWith('text-embedding') || m.startsWith('whisper')) return 'openai';

  // Groq-specific model IDs (contain size suffixes like -8192, -32768)
  if (/-(8192|32768|8b|70b|90b)$/.test(m)) return 'groq';

  // Embedded (SmolLM aliases)
  if (m.startsWith('smollm')) return 'embedded';

  return null;
}

/**
 * Commands that require tool calling should call this after creating the adapter.
 * If the provider does not support tools, prints a helpful message and exits.
 */
export function blockIfNoToolSupport(adapter: ProviderAdapter, command: string): void {
  if (adapter.info?.supportsTools === false) {
    process.stderr.write(
      `\n  The ${adapter.info.name} provider cannot handle "${command}" — it requires tool calling and complex reasoning.\n` +
      `  Use a provider that supports tools:\n\n` +
      `    jam ${command} --provider ollama\n` +
      `    jam ${command} --provider anthropic\n` +
      `    jam ${command} --provider openai\n\n`
    );
    process.exit(1);
  }
}

export async function createProvider(profile: Profile): Promise<ProviderAdapter> {
  // Auto-detect provider from model name if not explicitly set to a non-default value
  const provider = profile.provider;

  if (provider === 'ollama') {
    const { OllamaAdapter } = await import('./ollama.js');
    return new OllamaAdapter({
      baseUrl: profile.baseUrl,
      model: profile.model,
      requestTimeoutMs: profile.requestTimeoutMs,
      tlsCaPath: profile.tlsCaPath,
    });
  }

  if (provider === 'openai') {
    const { OpenAIAdapter } = await import('./openai.js');
    return new OpenAIAdapter({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: profile.apiKey,
      requestTimeoutMs: profile.requestTimeoutMs,
      tlsCaPath: profile.tlsCaPath,
    });
  }

  if (provider === 'groq') {
    const { GroqAdapter } = await import('./groq.js');
    return new GroqAdapter({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: profile.apiKey,
      requestTimeoutMs: profile.requestTimeoutMs,
      tlsCaPath: profile.tlsCaPath,
    });
  }

  if (provider === 'anthropic') {
    const { AnthropicAdapter } = await import('./anthropic.js');
    return new AnthropicAdapter({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: profile.apiKey,
      requestTimeoutMs: profile.requestTimeoutMs,
      tlsCaPath: profile.tlsCaPath,
    });
  }

  if (provider === 'embedded') {
    const { EmbeddedAdapter } = await import('./embedded.js');
    return new EmbeddedAdapter({
      model: profile.model,
    });
  }

  if (provider === 'copilot') {
    const { CopilotAdapter } = await import('./copilot.js');
    return new CopilotAdapter({
      apiKey: profile.apiKey,
      model: profile.model,
      baseUrl: process.env['JAM_VSCODE_LM_PORT']
        ? `http://127.0.0.1:${process.env['JAM_VSCODE_LM_PORT']}`
        : undefined,
      requestTimeoutMs: profile.requestTimeoutMs,
      tlsCaPath: profile.tlsCaPath,
    });
  }

  throw new JamError(
    `Unknown provider: "${provider}". Supported providers: ollama, openai, anthropic, groq, embedded, copilot`,
    'CONFIG_INVALID'
  );
}
