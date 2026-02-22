export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
}
