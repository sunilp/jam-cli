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

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const API_VERSION = '2023-06-01';

// Anthropic-private types — do not export
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    stop_reason?: string;
  };
  content_block?: AnthropicContentBlock;
  message?: {
    id: string;
    usage: { input_tokens: number; output_tokens: number };
  };
  usage?: { input_tokens: number; output_tokens: number };
}

interface AnthropicChatResponse {
  id: string;
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicModelsResponse {
  data: Array<{ id: string; display_name: string }>;
  has_more: boolean;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  // Filter out system messages — Anthropic uses a top-level system field.
  // Merge consecutive same-role messages (Anthropic requires alternating roles).
  const result: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'user' ? 'user' : 'assistant';
    const last = result[result.length - 1];
    if (last && last.role === role) {
      // Merge consecutive same-role messages
      last.content = `${last.content as string}\n\n${m.content}`;
    } else {
      result.push({ role, content: m.content });
    }
  }
  // Anthropic requires the first message to be from the user
  if (result.length > 0 && result[0]!.role !== 'user') {
    result.unshift({ role: 'user', content: '(continue)' });
  }
  return result;
}

function getApiKey(profileApiKey?: string): string | undefined {
  return profileApiKey ?? process.env['ANTHROPIC_API_KEY'];
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly info: ProviderInfo = {
    name: 'anthropic',
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
        'No Anthropic API key found. Set ANTHROPIC_API_KEY environment variable or configure apiKey in your profile.',
        'PROVIDER_AUTH_FAILED',
        { retryable: false }
      );
    }
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': API_VERSION,
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
        `Cannot reach Anthropic at ${this.baseUrl}. Check your network connection.`,
        'PROVIDER_UNAVAILABLE',
        { retryable: false, cause: err }
      );
    }

    if (response.status === 401) {
      throw new JamError(
        'Anthropic API key is invalid or expired. Set a valid ANTHROPIC_API_KEY.',
        'PROVIDER_AUTH_FAILED',
        { retryable: false, statusCode: response.status }
      );
    }

    if (!response.ok) {
      throw new JamError(
        `Anthropic returned HTTP ${response.status} from /v1/models.`,
        'PROVIDER_UNAVAILABLE',
        { retryable: false, statusCode: response.status }
      );
    }

    const data = (await response.json()) as AnthropicModelsResponse;
    return (data.data ?? []).map((m) => m.id).sort();
  }

  async validateCredentials(): Promise<void> {
    await this.listModels();
  }

  async *streamCompletion(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const messages = toAnthropicMessages(request.messages);

    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
      stream: true,
      ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };

    const headers = this.authHeaders();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new JamError(
        `Failed to connect to Anthropic at ${this.baseUrl}`,
        'PROVIDER_UNAVAILABLE',
        { retryable: true, cause: err }
      );
    }

    if (response.status === 401) {
      throw new JamError(
        'Anthropic API key is invalid or expired. Set a valid ANTHROPIC_API_KEY.',
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
      const errorBody = await response.text().catch(() => '');
      const lower = errorBody.toLowerCase();
      const isQuota = lower.includes('billing') || lower.includes('quota') || lower.includes('exceeded');
      if (isQuota) {
        throw new JamError(
          'Anthropic API quota exhausted. Check your billing at https://console.anthropic.com/settings/billing',
          'PROVIDER_QUOTA_EXHAUSTED',
          { retryable: false, statusCode: response.status }
        );
      }
      throw new JamError(
        'Anthropic rate limit reached. Try again shortly.',
        'PROVIDER_RATE_LIMITED',
        { retryable: true, statusCode: response.status }
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new JamError(
        `Anthropic error ${response.status}: ${errorText}`,
        'PROVIDER_STREAM_ERROR',
        { retryable: false, statusCode: response.status }
      );
    }

    if (!response.body) {
      throw new JamError('Anthropic returned empty response body', 'PROVIDER_STREAM_ERROR', {
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
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        let event: AnthropicStreamEvent;
        try {
          event = JSON.parse(trimmed.slice(6)) as AnthropicStreamEvent;
        } catch {
          continue;
        }

        if (event.type === 'content_block_delta' && event.delta?.text) {
          yield { delta: event.delta.text, done: false };
        } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
          const usage = event.usage;
          yield {
            delta: '',
            done: true,
            usage: usage
              ? {
                  promptTokens: usage.input_tokens,
                  completionTokens: usage.output_tokens,
                  totalTokens: usage.input_tokens + usage.output_tokens,
                }
              : undefined,
          };
        } else if (event.type === 'message_start' && event.message?.usage) {
          // message_start contains input token count; we'll report it at the end
        }
      }
    }
  }

  async chatWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    options: Pick<CompletionRequest, 'model' | 'temperature' | 'maxTokens' | 'systemPrompt'> = {}
  ): Promise<ChatWithToolsResponse> {
    const anthropicMessages = toAnthropicMessages(messages);

    const anthropicTools: AnthropicTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: {
        type: 'object' as const,
        properties: t.parameters.properties,
        required: t.parameters.required,
      },
    }));

    const body: Record<string, unknown> = {
      model: options.model ?? this.model,
      messages: anthropicMessages,
      tools: anthropicTools,
      max_tokens: options.maxTokens ?? 4096,
      ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    };

    const headers = this.authHeaders();
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      throw new JamError(
        `Failed to connect to Anthropic at ${this.baseUrl}`,
        'PROVIDER_UNAVAILABLE',
        { retryable: true, cause: err }
      );
    }

    if (response.status === 401) {
      throw new JamError(
        'Anthropic API key is invalid or expired. Set a valid ANTHROPIC_API_KEY.',
        'PROVIDER_AUTH_FAILED',
        { retryable: false, statusCode: response.status }
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new JamError(
        `Anthropic error ${response.status}: ${errorText}`,
        'PROVIDER_STREAM_ERROR',
        { retryable: false, statusCode: response.status }
      );
    }

    const data = (await response.json()) as AnthropicChatResponse;

    // Extract text content and tool calls from the response
    let textContent = '';
    const toolCalls: ToolCall[] = [];

    for (const block of data.content) {
      if (block.type === 'text' && block.text) {
        textContent += block.text;
      } else if (block.type === 'tool_use' && block.name && block.input) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input,
        });
      }
    }

    const usage = data.usage;
    return {
      content: textContent || null,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: usage
        ? {
            promptTokens: usage.input_tokens,
            completionTokens: usage.output_tokens,
            totalTokens: usage.input_tokens + usage.output_tokens,
          }
        : undefined,
    };
  }
}
