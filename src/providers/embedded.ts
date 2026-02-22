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
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

// ── Defaults ─────────────────────────────────────────────────────────────────

/**
 * Directory where embedded GGUF models are cached.
 * ~/.jam/models/
 */
const MODELS_DIR = join(homedir(), '.jam', 'models');

/**
 * Default model to download when no model is specified.
 * SmolLM2-360M is extremely lightweight (~250 MB quantized) and runs
 * comfortably on machines without a GPU.
 */
const DEFAULT_HF_REPO = 'HuggingFaceTB/SmolLM2-360M-Instruct-GGUF';
const DEFAULT_MODEL_FILENAME = 'smollm2-360m-instruct-q4_k_m.gguf';
const DEFAULT_MODEL_LABEL = 'SmolLM2-360M-Instruct-Q4_K_M';

/**
 * A curated list of known models users can request by short alias.
 * Maps alias → { repo, file }.
 */
const MODEL_ALIASES: Record<string, { repo: string; file: string }> = {
  'smollm2-135m': {
    repo: 'HuggingFaceTB/SmolLM2-135M-Instruct-GGUF',
    file: 'smollm2-135m-instruct-q4_k_m.gguf',
  },
  'smollm2-360m': {
    repo: 'HuggingFaceTB/SmolLM2-360M-Instruct-GGUF',
    file: 'smollm2-360m-instruct-q4_k_m.gguf',
  },
  'smollm2-1.7b': {
    repo: 'HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF',
    file: 'smollm2-1.7b-instruct-q4_k_m.gguf',
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureModelsDir(): void {
  if (!existsSync(MODELS_DIR)) {
    mkdirSync(MODELS_DIR, { recursive: true });
  }
}

/**
 * Resolve a model specifier to { repo, file }.
 * Supports:
 *   - Known aliases  → "smollm2-360m"
 *   - HF repo paths  → "HuggingFaceTB/SmolLM2-360M-Instruct-GGUF/smollm2-360m-instruct-q4_k_m.gguf"
 *   - Plain filenames → treated as already-downloaded under ~/.jam/models/
 */
function resolveModel(model?: string): { repo: string; file: string } | { localPath: string } {
  if (!model) {
    return { repo: DEFAULT_HF_REPO, file: DEFAULT_MODEL_FILENAME };
  }

  const lower = model.toLowerCase();
  if (MODEL_ALIASES[lower]) {
    return MODEL_ALIASES[lower];
  }

  // HF-style "org/repo/filename.gguf"
  const parts = model.split('/');
  if (parts.length >= 3 && model.endsWith('.gguf')) {
    const file = parts.pop()!;
    const repo = parts.join('/');
    return { repo, file };
  }

  // Already a local path or just a filename
  if (model.endsWith('.gguf')) {
    return { localPath: model.startsWith('/') ? model : join(MODELS_DIR, model) };
  }

  // Default: treat as alias key, fall back to default model
  return { repo: DEFAULT_HF_REPO, file: DEFAULT_MODEL_FILENAME };
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export class EmbeddedAdapter implements ProviderAdapter {
  readonly info: ProviderInfo = {
    name: 'embedded (experimental)',
    supportsStreaming: true,
  };

  private readonly modelSpec: string | undefined;
  // Lazy-loaded resources
  private _llama: unknown = null;
  private _model: unknown = null;

  constructor(options: { model?: string } = {}) {
    this.modelSpec = options.model;
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────

  /**
   * Lazily load node-llama-cpp, download the model if needed, and warm up.
   * All heavy work happens here so the constructor stays synchronous.
   */
  private async boot(): Promise<{ llama: any; model: any }> {
    if (this._llama && this._model) {
      return { llama: this._llama, model: this._model };
    }

    let nlc: any;
    try {
      nlc = await import('node-llama-cpp');
    } catch {
      throw new JamError(
        'The "embedded" provider requires the `node-llama-cpp` package.\n' +
          'Install it with:  npm install node-llama-cpp\n' +
          'Then run `jam doctor` to verify.',
        'PROVIDER_UNAVAILABLE',
        { retryable: false }
      );
    }

    ensureModelsDir();

    process.stderr.write(
      '\n  ⚠️  Embedded provider is EXPERIMENTAL. Quality is limited by small model size.\n' +
      '  For production workloads, consider using Ollama or OpenAI.\n\n'
    );

    const resolved = resolveModel(this.modelSpec);
    let modelPath: string;

    if ('localPath' in resolved) {
      modelPath = resolved.localPath;
      if (!existsSync(modelPath)) {
        throw new JamError(
          `Model file not found: ${modelPath}`,
          'PROVIDER_MODEL_NOT_FOUND',
          { retryable: false }
        );
      }
    } else {
      // Check if already downloaded
      const cached = join(MODELS_DIR, resolved.file);
      if (existsSync(cached)) {
        modelPath = cached;
      } else {
        process.stderr.write(
          `\n  Downloading embedded model: ${resolved.file}\n` +
            `  From: huggingface.co/${resolved.repo}\n` +
            `  Destination: ${cached}\n` +
            `  This is a one-time download...\n\n`
        );
        try {
          await nlc.downloadModel({
            url: `https://huggingface.co/${resolved.repo}/resolve/main/${resolved.file}`,
            dirPath: MODELS_DIR,
            fileName: resolved.file,
            onProgress: (progress: { downloaded: number; total: number }) => {
              const pct = Math.round((progress.downloaded / progress.total) * 100);
              process.stderr.write(`\r  Progress: ${pct}%`);
            },
          });
          process.stderr.write('\n  Download complete!\n\n');
        } catch (err) {
          throw new JamError(
            `Failed to download model "${resolved.file}" from huggingface.co/${resolved.repo}.\n` +
              `Check your internet connection and try again.`,
            'PROVIDER_UNAVAILABLE',
            { retryable: true, cause: err }
          );
        }
        modelPath = cached;
      }
    }

    try {
      const llama = await nlc.getLlama();
      const model = await llama.loadModel({ modelPath });
      this._llama = llama;
      this._model = model;
      return { llama, model };
    } catch (err) {
      throw new JamError(
        `Failed to load model from ${modelPath}. The file may be corrupted.\n` +
          `Try deleting it and re-running so it re-downloads.`,
        'PROVIDER_UNAVAILABLE',
        { retryable: true, cause: err }
      );
    }
  }

  // ── ProviderAdapter interface ────────────────────────────────────────────

  async validateCredentials(): Promise<void> {
    await this.boot();
  }

  async listModels(): Promise<string[]> {
    // List known aliases + any .gguf files already cached
    const aliases = Object.keys(MODEL_ALIASES);
    const cached: string[] = [];

    try {
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(MODELS_DIR);
      for (const f of files) {
        if (f.endsWith('.gguf')) {
          cached.push(f);
        }
      }
    } catch {
      // Models dir may not exist yet — that's fine
    }

    return [
      ...aliases.map((a) => `${a} (alias)`),
      ...cached.map((f) => `${f} (cached)`),
    ];
  }

  async *streamCompletion(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const { model } = await this.boot();

    // node-llama-cpp v3 API
    const nlc = await import('node-llama-cpp');
    const context = await model.createContext();
    const session = new nlc.LlamaChatSession({ contextSequence: context.getSequence() });

    // Build prompt from messages
    const promptParts: string[] = [];
    if (request.systemPrompt) {
      promptParts.push(request.systemPrompt);
    }
    for (const msg of request.messages) {
      if (msg.role === 'system') {
        promptParts.push(msg.content);
      } else if (msg.role === 'user') {
        promptParts.push(msg.content);
      } else if (msg.role === 'assistant') {
        promptParts.push(msg.content);
      }
    }

    // Get the last user message as the prompt (chat session manages history)
    const lastUserMsg = [...request.messages].reverse().find((m) => m.role === 'user');
    const prompt = lastUserMsg?.content ?? promptParts.join('\n');

    let totalTokens = 0;
    let completionText = '';

    try {
      const response = await session.prompt(prompt, {
        maxTokens: request.maxTokens ?? 2048,
        temperature: request.temperature ?? 0.7,
        onTextChunk: undefined, // we'll use the non-streaming path and chunk it
      });

      completionText = response;
      totalTokens = completionText.split(/\s+/).length; // rough estimate

      // Emit the complete response as chunks for streaming compatibility
      const chunkSize = 4; // characters per chunk for simulated streaming
      for (let i = 0; i < completionText.length; i += chunkSize) {
        const delta = completionText.slice(i, i + chunkSize);
        yield { delta, done: false };
      }

      yield {
        delta: '',
        done: true,
        usage: {
          promptTokens: 0, // node-llama-cpp doesn't expose this easily
          completionTokens: totalTokens,
          totalTokens,
        },
      };
    } finally {
      context.dispose();
    }
  }

  async chatWithTools(
    messages: Message[],
    tools: ToolDefinition[],
    options: Pick<CompletionRequest, 'model' | 'temperature' | 'maxTokens' | 'systemPrompt'> = {}
  ): Promise<ChatWithToolsResponse> {
    const { model } = await this.boot();
    const nlc = await import('node-llama-cpp');

    const context = await model.createContext();
    const session = new nlc.LlamaChatSession({ contextSequence: context.getSequence() });

    // Build prompt that describes available tools (small models won't do
    // native function calling, so we describe them in the system prompt).
    const toolDescriptions = tools.map((t) => {
      const params = Object.entries(t.parameters.properties)
        .map(([name, schema]) => `  - ${name} (${schema.type}): ${schema.description ?? ''}`)
        .join('\n');
      return `Tool: ${t.name}\nDescription: ${t.description}\nParameters:\n${params}`;
    }).join('\n\n');

    const systemInstructions = [
      options.systemPrompt ?? '',
      tools.length > 0
        ? `You have access to the following tools. To call a tool, respond with EXACTLY this JSON format on its own line:\n` +
          `{"tool_call": {"name": "<tool_name>", "arguments": {<args>}}}\n\n` +
          `Available tools:\n${toolDescriptions}`
        : '',
    ].filter(Boolean).join('\n\n');

    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    const prompt = (systemInstructions ? systemInstructions + '\n\n' : '') +
      (lastUserMsg?.content ?? '');

    let response: string;
    try {
      response = await session.prompt(prompt, {
        maxTokens: options.maxTokens ?? 2048,
        temperature: options.temperature ?? 0.3,
      });
    } finally {
      context.dispose();
    }

    // Parse tool calls from the response
    const toolCalls: ToolCall[] = [];
    const lines = response.split('\n');
    const textParts: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('{"tool_call"')) {
        try {
          const parsed = JSON.parse(trimmed) as { tool_call: { name: string; arguments: Record<string, unknown> } };
          toolCalls.push({
            name: parsed.tool_call.name,
            arguments: parsed.tool_call.arguments,
          });
          continue;
        } catch {
          // Not valid JSON — treat as text
        }
      }
      textParts.push(line);
    }

    return {
      content: textParts.join('\n').trim() || null,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
    };
  }
}
