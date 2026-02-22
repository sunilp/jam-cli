import { OpenAIAdapter } from './openai.js';
import type { ProviderInfo } from './base.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai';
const DEFAULT_MODEL = 'llama3-8b-8192';

/**
 * Groq provider adapter.
 * Groq's API is OpenAI-compatible, so this extends OpenAIAdapter with
 * Groq-specific defaults (base URL, model, env var for API key).
 */
export class GroqAdapter extends OpenAIAdapter {
  override readonly info: ProviderInfo = {
    name: 'groq',
    supportsStreaming: true,
  };

  constructor(options: { baseUrl?: string; model?: string; apiKey?: string } = {}) {
    const apiKey = options.apiKey ?? process.env['GROQ_API_KEY'];
    super({
      baseUrl: options.baseUrl ?? GROQ_BASE_URL,
      model: options.model ?? DEFAULT_MODEL,
      apiKey,
    });
  }
}
