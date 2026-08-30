import { createProvider } from '../providers/factory.js';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import type { ModelProvider, ModelRequest, ModelTurnResult, ProviderCapabilities } from './model.js';
import type { ProviderToolDefinition } from './tools/registry.js';
import type { ProviderAdapter, ToolDefinition, ChatWithToolsResponse } from '../providers/base.js';
import type { CliOverrides } from '../config/schema.js';

/**
 * jam's `ToolParameterSchema` has no `array`/`items` case — none of jam's own
 * built-in commands has ever needed one. The harness's run_command tool does
 * (`args: string[]`), and its JSON Schema output is a strict superset of that
 * shape. Every existing adapter (anthropic.ts, openai.ts, ollama.ts) forwards
 * `parameters` opaquely into the outgoing request body — none destructures
 * individual `ToolParameterSchema` fields — so the extra `items` key on an
 * array parameter still reaches the wire exactly as produced. This cast
 * documents that gap rather than silently working around it.
 */
function toToolDefinitions(tools: ProviderToolDefinition[]): ToolDefinition[] {
  return tools as unknown as ToolDefinition[];
}

/**
 * Adapts jam's existing ProviderAdapter to the harness ModelProvider seam.
 * The loop must contain no provider-specific behavior, so all normalization
 * happens here. Exported for testing (provider-factory.test.ts constructs it
 * directly against a fake ProviderAdapter, rather than mocking config/loader
 * and providers/factory just to exercise generate()'s own logic).
 */
export class AdaptedProvider implements ModelProvider {
  constructor(
    private readonly adapter: ProviderAdapter,
    readonly name: string,
    readonly model: string
  ) {}

  capabilities(): Promise<ProviderCapabilities> {
    return Promise.resolve({
      toolCalling: this.adapter.info.supportsTools !== false,
      streaming: this.adapter.info.supportsStreaming,
      contextWindow: this.adapter.info.contextWindow ?? 128_000,
    });
  }

  async generate(req: ModelRequest, signal: AbortSignal): Promise<ModelTurnResult> {
    if (signal.aborted) return { content: null, toolCalls: [] };

    const chat = this.adapter.chatWithTools?.bind(this.adapter);
    if (chat === undefined) {
      // Caught earlier in createHarnessProvider, but guard again: a provider
      // can lose tool support after construction (e.g. a lazy credential
      // check downgrades it), and the loop must still terminate cleanly.
      return { content: null, toolCalls: [], unrecoverable: true };
    }

    // jam's own Message role has no 'tool' member; tool results are folded
    // into user turns. Nothing is lost, because the journal is the real
    // history — this mapping only affects what the model sees this turn.
    const chatPromise = chat(
      req.messages.map((m) => ({
        role: m.role === 'tool' ? ('user' as const) : m.role,
        content: m.content,
      })),
      toToolDefinitions(req.tools),
      req.maxTokens === undefined ? undefined : { maxTokens: req.maxTokens }
    );
    // jam's ProviderAdapter.chatWithTools takes no AbortSignal (do not modify
    // src/providers), so there is no way to cancel the in-flight HTTP request
    // itself — Ctrl-C could not interrupt the single longest operation in the
    // loop. A rejection here after the abort branch below has already won the
    // race must not surface as an unhandled rejection.
    chatPromise.catch(() => { /* observed via the race below, or discarded */ });

    // Racing makes generate() RESOLVE PROMPTLY on abort, so the loop becomes
    // responsive to Ctrl-C again. This does NOT cancel the request: the real
    // chatWithTools call keeps running in the background regardless of which
    // side of the race wins, and its eventual result (or error) is simply
    // discarded once an abort has already been reported.
    const aborted = new Promise<ChatWithToolsResponse>((resolve) => {
      if (signal.aborted) { resolve({ content: null, toolCalls: [] }); return; }
      signal.addEventListener(
        'abort', () => resolve({ content: null, toolCalls: [] }), { once: true }
      );
    });

    const res = await Promise.race([chatPromise, aborted]);

    return {
      content: res.content,
      toolCalls: (res.toolCalls ?? []).map((c, i) => ({
        id: c.id ?? String(i), name: c.name, arguments: c.arguments,
      })),
      usage: res.usage,
    };
  }

  countTokens(req: ModelRequest): Promise<number> {
    return Promise.resolve(
      Math.ceil(req.messages.reduce((n, m) => n + m.content.length, 0) / 4)
    );
  }
}

export async function createHarnessProvider(
  opts: { provider?: string; model?: string; profile?: string }
): Promise<ModelProvider> {
  const overrides: CliOverrides = {
    profile: opts.profile, provider: opts.provider, model: opts.model,
  };
  const config = await loadConfig(process.cwd(), overrides);
  const profile = getActiveProfile(config);
  const adapter = await createProvider(profile);

  // Fail early and clearly rather than looping with a model that cannot call
  // tools: the harness has no fallback path for a text-only reply, and every
  // round would just burn budget until COMPLETED_UNVERIFIED.
  if (adapter.info.supportsTools === false || adapter.chatWithTools === undefined) {
    throw new Error(
      `Provider "${adapter.info.name}" does not support tool calling, which the agent ` +
      `requires. Choose another with --provider.`
    );
  }
  return new AdaptedProvider(adapter, adapter.info.name, opts.model ?? profile.model ?? 'default');
}
