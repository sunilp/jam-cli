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

export async function createProvider(profile: Profile): Promise<ProviderAdapter> {
  // Auto-detect provider from model name if not explicitly set to a non-default value
  const provider = profile.provider;

  if (provider === 'ollama') {
    const { OllamaAdapter } = await import('./ollama.js');
    return new OllamaAdapter({
      baseUrl: profile.baseUrl,
      model: profile.model,
    });
  }

  if (provider === 'openai') {
    const { OpenAIAdapter } = await import('./openai.js');
    return new OpenAIAdapter({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: profile.apiKey,
    });
  }

  if (provider === 'groq') {
    const { GroqAdapter } = await import('./groq.js');
    return new GroqAdapter({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: profile.apiKey,
    });
  }

  if (provider === 'anthropic') {
    const { AnthropicAdapter } = await import('./anthropic.js');
    return new AnthropicAdapter({
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: profile.apiKey,
    });
  }

  if (provider === 'embedded') {
    process.stderr.write(
      '\n  \x1b[33m[EXPERIMENTAL]\x1b[0m Using embedded provider — model runs in-process via node-llama-cpp.\n' +
      '  Model will be downloaded on first use only when provider is set to "embedded".\n\n'
    );
    const { EmbeddedAdapter } = await import('./embedded.js');
    return new EmbeddedAdapter({
      model: profile.model,
    });
  }

  throw new JamError(
    `Unknown provider: "${provider}". Supported providers: ollama, openai, anthropic, groq, embedded`,
    'CONFIG_INVALID'
  );
}
