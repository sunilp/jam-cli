import type { ToolCall, TokenUsage } from './events.js';
import type { ProviderToolDefinition } from './tools/registry.js';
import type { TelemetrySink } from './telemetry.js';
import { NullTelemetry } from './telemetry.js';

export interface ModelMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }

export interface ModelRequest {
  messages: ModelMessage[];
  tools: ProviderToolDefinition[];
  maxTokens?: number;
}

export interface ModelTurnResult {
  content: string | null;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  /** Set when the provider failed in a way retrying cannot fix. */
  unrecoverable?: boolean;
}

export interface ProviderCapabilities {
  toolCalling: boolean;
  streaming: boolean;
  contextWindow: number;
}

/**
 * The loop's view of a model. Deliberately distinct from a future
 * AgentProvider: Claude API is a model, Claude Code is an entire agent.
 * Do not widen this interface to cover the latter.
 */
export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  capabilities(): Promise<ProviderCapabilities>;
  generate(req: ModelRequest, signal: AbortSignal): Promise<ModelTurnResult>;
  countTokens(req: ModelRequest): Promise<number>;
}

export interface ScriptedTurn {
  content: string | null;
  toolCalls: ToolCall[];
  deltas?: string[];
  usage?: TokenUsage;
}

/** Test double. Makes every loop path assertable without a network. */
export class MockProvider implements ModelProvider {
  readonly name = 'mock';
  readonly model = 'mock';
  private index = 0;

  constructor(
    private readonly script: ScriptedTurn[],
    private readonly telemetry: TelemetrySink = new NullTelemetry()
  ) {}

  capabilities(): Promise<ProviderCapabilities> {
    return Promise.resolve({ toolCalling: true, streaming: true, contextWindow: 200_000 });
  }

  generate(_req: ModelRequest, _signal: AbortSignal): Promise<ModelTurnResult> {
    const turn = this.script[this.index];
    if (turn === undefined) {
      return Promise.resolve({ content: null, toolCalls: [], unrecoverable: true });
    }
    this.index += 1;
    for (const d of turn.deltas ?? []) {
      this.telemetry.write({ kind: 'model.delta', text: d });
    }
    return Promise.resolve({ content: turn.content, toolCalls: turn.toolCalls, usage: turn.usage });
  }

  countTokens(req: ModelRequest): Promise<number> {
    return Promise.resolve(Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4));
  }
}
