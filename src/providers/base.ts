export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ── Tool-calling types ────────────────────────────────────────────────────────

export interface ToolParameterSchema {
  type: string;
  description?: string;
  enum?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameterSchema>;
    required?: string[];
  };
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatWithToolsResponse {
  content: string | null;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
  usage?: TokenUsage;
}

export interface CompletionRequest {
  messages: Message[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface ProviderInfo {
  name: string;
  supportsStreaming: boolean;
}

export interface ProviderAdapter {
  info: ProviderInfo;
  validateCredentials(): Promise<void>;
  streamCompletion(request: CompletionRequest): AsyncIterable<StreamChunk>;
  listModels(): Promise<string[]>;
  /** Optional: single non-streaming turn that may return tool calls. */
  chatWithTools?(
    messages: Message[],
    tools: ToolDefinition[],
    options?: Pick<CompletionRequest, 'model' | 'temperature' | 'maxTokens' | 'systemPrompt'>
  ): Promise<ChatWithToolsResponse>;
}
