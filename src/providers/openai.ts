import type {
  ProviderAdapter,
  ProviderInfo,
  CompletionRequest,
  StreamChunk,
  Message,
  ToolDefinition,
  ToolCall,
  ChatWithToolsResponse,
} from './base.js';
import { JamError } from '../utils/errors.js';

const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_MODEL = 'gpt-4o-mini';

// OpenAI-private types — do not export
interface OpenAIChatMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

interface OpenAIStreamChunk {
  id: string;
  choices: Array<{
    delta: { content?: string | null; role?: string };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIChatResponse {
  id: string;
  choices: Array<{
    message: OpenAIChatMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIModelsResponse {
  data: Array<{ id: string }>;
}

function toOpenAIMessages(messages: Message[]): OpenAIChatMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function getApiKey(profileApiKey?: string): string | undefined {
  return profileApiKey ?? process.env['OPENAI_API_KEY'];
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly info: ProviderInfo = {
    name: 'openai',
    supportsStreaming: true,
  };

  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;

  constructor(options: { baseUrl?: string; model?: string; apiKey?: string } = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = options.model ?? DEFAULT_MODEL;
    this.apiKey = getApiKey(options.apiKey);
  }

  private authHeaders(): Record<string, string> {
    if (!this.apiKey) {
      throw new JamError(
        'No OpenAI API key found. Set OPENAI_API_KEY environment variable or configure apiKey in your profile.',
        'PROVIDER_AUTH_FAILED',
        { retryable: false }
      );
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
  }

  async listModels(): Promise<string[]> {
    const headers = this.authHeaders();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/models`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new JamError(
        `Cannot reach OpenAI at ${this.baseUrl}. Check your network connection.`,
        'PROVIDER_UNAVAILABLE',
        { retryable: false, cause: err }
      );
    }

    if (response.status === 401) {
      throw new JamError(
        'OpenAI API key is invalid or expired. Set a valid OPENAI_API_KEY.',
        'PROVIDER_AUTH_FAILED',
        { retryable: false, statusCode: response.status }
      );
    }

    if (!response.ok) {
      throw new JamError(
        `OpenAI returned HTTP ${response.status} from /v1/models.`,
        'PROVIDER_UNAVAILABLE',
        { retryable: false, statusCode: response.status }
      );
    }

    const data = (await response.json()) as OpenAIModelsResponse;
    return (data.data ?? []).map((m) => m.id).sort();
  }

  async validateCredentials(): Promise<void> {
    // A lightweight check: list models (requires a valid API key)
    await this.listModels();
  }

  async *streamCompletion(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const messages: OpenAIChatMessage[] = [];
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push(...toOpenAIMessages(request.messages));

    const body = {
      model: request.model ?? this.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
    };

    const headers = this.authHeaders();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new JamError(
        `Failed to connect to OpenAI at ${this.baseUrl}`,
        'PROVIDER_UNAVAILABLE',
        { retryable: true, cause: err }
      );
    }

    if (response.status === 401) {
      throw new JamError(
        'OpenAI API key is invalid or expired. Set a valid OPENAI_API_KEY.',
        'PROVIDER_AUTH_FAILED',
        { retryable: false, statusCode: response.status }
      );
    }

    if (response.status === 404) {
      throw new JamError(
        `Model not found: ${request.model ?? this.model}. Check available models with: jam models list`,
        'PROVIDER_MODEL_NOT_FOUND',
        { retryable: false, statusCode: response.status }
      );
    }

    if (response.status === 429) {
      throw new JamError(
        'OpenAI rate limit reached. Try again shortly.',
        'PROVIDER_RATE_LIMITED',
        { retryable: true, statusCode: response.status }
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new JamError(
        `OpenAI error ${response.status}: ${errorText}`,
        'PROVIDER_STREAM_ERROR',
        { retryable: false, statusCode: response.status }
      );
    }

    if (!response.body) {
      throw new JamError('OpenAI returned empty response body', 'PROVIDER_STREAM_ERROR', {
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
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        let parsed: OpenAIStreamChunk;
        try {
          parsed = JSON.parse(trimmed.slice(6)) as OpenAIStreamChunk;
        } catch {
          continue;
        }

        const choice = parsed.choices?.[0];
        if (choice) {
          const delta = choice.delta.content ?? '';
          const done = choice.finish_reason !== null;
          if (done) {
            const usage = parsed.usage;
            yield {
              delta: '',
              done: true,
              usage: usage
                ? {
                    promptTokens: usage.prompt_tokens,
                    completionTokens: usage.completion_tokens,
                    totalTokens: usage.total_tokens,
                  }
                : undefined,
            };
          } else if (delta) {
            yield { delta, done: false };
          }
        } else if (parsed.usage) {
          // usage-only chunk (stream_options.include_usage)
          yield {
            delta: '',
            done: true,
            usage: {
              promptTokens: parsed.usage.prompt_tokens,
              completionTokens: parsed.usage.completion_tokens,
              totalTokens: parsed.usage.total_tokens,
            },
          };
        }
      }
    }
  }

  async chatWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    options: Pick<CompletionRequest, 'model' | 'temperature' | 'maxTokens' | 'systemPrompt'> = {}
  ): Promise<ChatWithToolsResponse> {
    const openAIMessages: OpenAIChatMessage[] = [];
    if (options.systemPrompt) {
      openAIMessages.push({ role: 'system', content: options.systemPrompt });
    }
    openAIMessages.push(...toOpenAIMessages(messages));

    const body = {
      model: options.model ?? this.model,
      messages: openAIMessages,
      tools: tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    };

    const headers = this.authHeaders();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new JamError(
        `Failed to connect to OpenAI at ${this.baseUrl}`,
        'PROVIDER_UNAVAILABLE',
        { retryable: true, cause: err }
      );
    }

    if (response.status === 401) {
      throw new JamError(
        'OpenAI API key is invalid or expired. Set a valid OPENAI_API_KEY.',
        'PROVIDER_AUTH_FAILED',
        { retryable: false, statusCode: response.status }
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new JamError(
        `OpenAI error ${response.status}: ${errorText}`,
        'PROVIDER_STREAM_ERROR',
        { retryable: false, statusCode: response.status }
      );
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const msg = data.choices[0]?.message;
    if (!msg) {
      throw new JamError('OpenAI returned no choices.', 'PROVIDER_STREAM_ERROR', {
        retryable: false,
      });
    }

    const toolCalls: ToolCall[] | undefined = msg.tool_calls?.map((tc) => {
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        throw new JamError(
          `Failed to parse tool call arguments from OpenAI response for tool "${tc.function.name}"`,
          'PROVIDER_STREAM_ERROR',
          { retryable: false }
        );
      }
      return {
        id: tc.id,
        name: tc.function.name,
        arguments: parsedArgs,
      };
    });

    const usage = data.usage;
    return {
      content: msg.content ?? null,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
          }
        : undefined,
    };
  }
}
