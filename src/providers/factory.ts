import type { ProviderAdapter } from './base.js';
import type { Profile } from '../config/schema.js';
import { JamError } from '../utils/errors.js';

export async function createProvider(profile: Profile): Promise<ProviderAdapter> {
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
    `Unknown provider: "${provider}". Supported providers: ollama, openai, groq, embedded`,
    'CONFIG_INVALID'
  );
}
