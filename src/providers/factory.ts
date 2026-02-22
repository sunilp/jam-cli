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

  throw new JamError(
    `Unknown provider: "${provider}". Supported providers: ollama, openai, groq`,
    'CONFIG_INVALID'
  );
}
