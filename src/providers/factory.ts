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

  throw new JamError(
    `Unknown provider: "${provider}". Supported providers: ollama`,
    'CONFIG_INVALID'
  );
}
