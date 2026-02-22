import type { ProviderAdapter, ProviderInfo, CompletionRequest, StreamChunk, Message } from './base.js';
import { JamError } from '../utils/errors.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';

// Ollama-private types — do not export
interface OllamaMessage {
  role: string;
  content: string;
}

interface OllamaStreamChunk {
  model: string;
  created_at: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

function toOllamaMessages(messages: Message[]): OllamaMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function parseNDJSONLine(line: string): OllamaStreamChunk | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as OllamaStreamChunk;
  } catch {
    return null;
  }
}

export class OllamaAdapter implements ProviderAdapter {
  readonly info: ProviderInfo = {
    name: 'ollama',
    supportsStreaming: true,
  };

  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: { baseUrl?: string; model?: string } = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = options.model ?? 'llama3.2';
  }

  async listModels(): Promise<string[]> {
    interface OllamaTagsResponse {
      models: Array<{ name: string }>;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      throw new JamError(
        `Cannot reach Ollama at ${this.baseUrl}. Start Ollama with: ollama serve`,
        'PROVIDER_UNAVAILABLE',
        { retryable: false, cause: err }
      );
    }

    if (!response.ok) {
      throw new JamError(
        `Ollama returned HTTP ${response.status}. Is Ollama running at ${this.baseUrl}?`,
        'PROVIDER_UNAVAILABLE',
        { retryable: false }
      );
    }

    const data = (await response.json()) as OllamaTagsResponse;
    return (data.models ?? []).map((m) => m.name);
  }

  async validateCredentials(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new JamError(
          `Ollama returned HTTP ${response.status}. Is Ollama running at ${this.baseUrl}?`,
          'PROVIDER_UNAVAILABLE',
          { retryable: false }
        );
      }
    } catch (err) {
      if (JamError.isJamError(err)) throw err;
      throw new JamError(
        `Cannot reach Ollama at ${this.baseUrl}. Start Ollama with: ollama serve`,
        'PROVIDER_UNAVAILABLE',
        { retryable: false, cause: err }
      );
    }
  }

  async *streamCompletion(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const messages: OllamaMessage[] = [];

    const systemPrompt = request.systemPrompt;
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push(...toOllamaMessages(request.messages));

    const body = {
      model: request.model ?? this.model,
      messages,
      stream: true,
      options: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
      },
    };

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new JamError(
        `Failed to connect to Ollama at ${this.baseUrl}`,
        'PROVIDER_UNAVAILABLE',
        { retryable: true, cause: err }
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      if (response.status === 404) {
        throw new JamError(
          `Model not found: ${request.model ?? this.model}. Pull it with: ollama pull ${request.model ?? this.model}`,
          'PROVIDER_MODEL_NOT_FOUND',
          { retryable: false, statusCode: response.status }
        );
      }
      if (response.status === 429) {
        throw new JamError(
          'Ollama rate limited. Try again shortly.',
          'PROVIDER_RATE_LIMITED',
          { retryable: true, statusCode: response.status }
        );
      }
      throw new JamError(
        `Ollama error ${response.status}: ${errorText}`,
        'PROVIDER_STREAM_ERROR',
        { retryable: false, statusCode: response.status }
      );
    }

    if (!response.body) {
      throw new JamError('Ollama returned empty response body', 'PROVIDER_STREAM_ERROR', {
        retryable: true,
      });
    }

    const decoder = new TextDecoder();
    let buffer = '';

    for await (const rawChunk of response.body) {
      buffer += decoder.decode(rawChunk as Uint8Array, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const parsed = parseNDJSONLine(line);
        if (!parsed) continue;

        if (!parsed.done) {
          yield {
            delta: parsed.message.content,
            done: false,
          };
        } else {
          const promptTokens = parsed.prompt_eval_count ?? 0;
          const completionTokens = parsed.eval_count ?? 0;
          yield {
            delta: '',
            done: true,
            usage: {
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            },
          };
        }
      }
    }

    // Flush any remaining buffer
    if (buffer.trim()) {
      const parsed = parseNDJSONLine(buffer);
      if (parsed?.done) {
        const promptTokens = parsed.prompt_eval_count ?? 0;
        const completionTokens = parsed.eval_count ?? 0;
        yield {
          delta: '',
          done: true,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
          },
        };
      }
    }
  }
}
