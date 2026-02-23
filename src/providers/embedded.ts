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
import { existsSync, mkdirSync, createWriteStream, unlinkSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// ── Defaults ─────────────────────────────────────────────────────────────────

/**
 * Directory where embedded GGUF models are cached.
 * ~/.jam/models/
 */
const MODELS_DIR = join(homedir(), '.jam', 'models');

/**
 * GitHub repository that hosts GGUF model files as release assets.
 * Models are uploaded as assets under the tag MODELS_RELEASE_TAG.
 */
const GITHUB_MODELS_OWNER = 'sunilp';
const GITHUB_MODELS_REPO = 'homebrew-tap';
const GITHUB_MODELS_TAG = 'v1.0.0';

/** Construct a GitHub Releases download URL for a model file. */
function githubModelUrl(file: string): string {
  return `https://github.com/${GITHUB_MODELS_OWNER}/${GITHUB_MODELS_REPO}/releases/download/${GITHUB_MODELS_TAG}/${file}`;
}

/**
 * Default model to download when no model is specified.
 * SmolLM2-360M is extremely lightweight (~360 MB quantized) and runs
 * comfortably on machines without a GPU.
 */
const DEFAULT_MODEL_FILENAME = 'smollm2-1.7b-instruct-q4_k_m.gguf';

/**
 * A curated list of known models users can request by short alias.
 * Maps alias → { url, file }.
 * Files are hosted as release assets on github.com/sunilp/homebrew-tap.
 */
const MODEL_ALIASES: Record<string, { url: string; file: string }> = {
  'smollm2-360m': {
    url: githubModelUrl('smollm2-360m-instruct-q8_0.gguf'),
    file: 'smollm2-360m-instruct-q8_0.gguf',
  },
  'smollm2-1.7b': {
    url: githubModelUrl('smollm2-1.7b-instruct-q4_k_m.gguf'),
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
 * Download a file from `url` to `destPath`, following redirects and reporting
 * progress. Uses Node's built-in `fetch` (Node 18+) so no extra dependencies
 * are needed. Cleans up the partial file on failure.
 */
async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  }

  const total = Number(res.headers.get('content-length') ?? '0');
  let downloaded = 0;

  const writer = createWriteStream(destPath);
  try {
    const reader = res.body.getReader();
    const nodeReadable = new Readable({
      async read() {
        const { done, value } = await reader.read() as { done: boolean; value: Uint8Array | undefined };
        if (done || value === undefined) {
          this.push(null);
        } else {
          downloaded += value.byteLength;
          if (onProgress) onProgress(downloaded, total);
          this.push(Buffer.from(value));
        }
      },
    });
    await pipeline(nodeReadable, writer);
  } catch (err) {
    // Remove partial file so a retry starts fresh
    try { unlinkSync(destPath); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Resolve a model specifier to { url, file } for a remote download, or
 * { localPath } for a file already on disk.
 *
 * Supports:
 *   - Known aliases       → "smollm2-360m"
 *   - HF repo paths       → "HuggingFaceTB/SmolLM2-360M-Instruct-GGUF/smollm2-360m-instruct-q8_0.gguf"
 *   - Full HTTPS URLs     → "https://example.com/path/to/model.gguf"
 *   - Plain filenames     → treated as already-downloaded under ~/.jam/models/
 */
function resolveModel(model?: string): { url: string; file: string } | { localPath: string } {
  if (!model) {
    return { url: githubModelUrl(DEFAULT_MODEL_FILENAME), file: DEFAULT_MODEL_FILENAME };
  }

  const lower = model.toLowerCase();
  if (MODEL_ALIASES[lower]) {
    return MODEL_ALIASES[lower];
  }

  // Full HTTPS URL supplied directly
  if (model.startsWith('https://') && model.endsWith('.gguf')) {
    const file = model.split('/').pop()!;
    return { url: model, file };
  }

  // HF-style "org/repo/filename.gguf" — construct the HuggingFace URL
  const parts = model.split('/');
  if (parts.length >= 3 && model.endsWith('.gguf')) {
    const file = parts.pop()!;
    const repo = parts.join('/');
    return { url: `https://huggingface.co/${repo}/resolve/main/${file}`, file };
  }

  // Already a local path or just a filename
  if (model.endsWith('.gguf')) {
    return { localPath: model.startsWith('/') ? model : join(MODELS_DIR, model) };
  }

  // Default: fall back to default model hosted on GitHub
  return { url: githubModelUrl(DEFAULT_MODEL_FILENAME), file: DEFAULT_MODEL_FILENAME };
}

// ── Adapter ──────────────────────────────────────────────────────────────────

/**
 * Minimal type definitions for the subset of node-llama-cpp API we use.
 * These let us avoid `any` while keeping node-llama-cpp a lazy dynamic import.
 */
interface LlamaInstance {
  loadModel(opts: { modelPath: string }): Promise<LlamaModel>;
}

interface LlamaModel {
  createContext(): Promise<LlamaContext>;
}

interface LlamaContext {
  getSequence(): unknown;
  dispose(): void;
}

interface LlamaChatSessionInstance {
  prompt(text: string, opts?: { maxTokens?: number; temperature?: number }): Promise<string>;
}

interface NodeLlamaCppModule {
  getLlama(): Promise<LlamaInstance>;
  LlamaChatSession: new (opts: { contextSequence: unknown; systemPrompt?: string }) => LlamaChatSessionInstance;
}

export class EmbeddedAdapter implements ProviderAdapter {
  readonly info: ProviderInfo = {
    name: 'embedded (experimental)',
    supportsStreaming: true,
    // 1.7B is too small to reliably emit valid JSON tool-call payloads for
    // the ReAct scaffold. Direct Q&A and commit generation work well instead.
    supportsTools: false,
    // SmolLM2-1.7B context window. Used to guard input truncation.
    contextWindow: 8192,
  };

  private readonly modelSpec: string | undefined;
  // Lazy-loaded resources
  private _llama: LlamaInstance | null = null;
  private _model: LlamaModel | null = null;

  constructor(options: { model?: string } = {}) {
    this.modelSpec = options.model;
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────

  /**
   * Lazily load node-llama-cpp, download the model if needed, and warm up.
   * All heavy work happens here so the constructor stays synchronous.
   */
  private async boot(): Promise<{ llama: LlamaInstance; model: LlamaModel }> {
    if (this._llama && this._model) {
      return { llama: this._llama, model: this._model };
    }

    let nlc: NodeLlamaCppModule;
    try {
      nlc = await import('node-llama-cpp') as unknown as NodeLlamaCppModule;
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
            `  From: ${resolved.url}\n` +
            `  Destination: ${cached}\n` +
            `  This is a one-time download...\n\n`
        );
        try {
          await downloadFile(
            resolved.url,
            cached,
            (downloaded, total) => {
              const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
              const mb = (downloaded / 1_048_576).toFixed(1);
              process.stderr.write(`\r  Progress: ${pct}% (${mb} MB)`);
            },
          );
          process.stderr.write('\n  Download complete!\n\n');
        } catch (err) {
          throw new JamError(
            `Failed to download model "${resolved.file}" from ${resolved.url}.\n` +
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
    const nlc = await import('node-llama-cpp') as unknown as NodeLlamaCppModule;
    const context = await model.createContext();

    // System prompt goes into the session constructor — NOT into the user message.
    // Passing it as a user-message prefix causes the model to echo it back verbatim.
    const session: LlamaChatSessionInstance = new nlc.LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: request.systemPrompt,
    });

    // Guard against context window overflow.
    // Rough estimate: 1 token ≈ 4 characters. Reserve (maxTokens ?? 512) tokens
    // for the completion and a 10% safety margin.
    const maxOutputTokens = request.maxTokens ?? 512;
    const contextWindow = this.info.contextWindow ?? 2048;
    const systemTokens = Math.ceil((request.systemPrompt?.length ?? 0) / 4);
    const inputBudgetTokens = contextWindow - maxOutputTokens - systemTokens - Math.ceil(contextWindow * 0.1);
    const inputBudgetChars = Math.max(200, inputBudgetTokens * 4);

    // For multi-turn history replay prior (user → assistant) pairs so the
    // session has conversation context, then send the final user message.
    const nonSystemMsgs = request.messages.filter((m) => m.role !== 'system');
    const lastUserIdx = nonSystemMsgs.map((m) => m.role).lastIndexOf('user');
    const priorMsgs = nonSystemMsgs.slice(0, lastUserIdx);
    const lastUserMsg = nonSystemMsgs[lastUserIdx];

    // Replay prior conversation turns into the session (pairs: user then assistant).
    for (let i = 0; i < priorMsgs.length; i++) {
      const msg = priorMsgs[i]!;
      if (msg.role === 'user') {
        const next = priorMsgs[i + 1];
        if (next?.role === 'assistant') {
          await session.prompt(msg.content, { maxTokens: 1 });
        }
      }
    }

    // Truncate the final user message if it would overflow the input budget.
    // For git diffs, cut at a "diff --git" hunk boundary so the model always
    // receives complete, coherent hunks rather than a mid-line slice.
    let promptText = lastUserMsg?.content ?? '';
    if (promptText.length > inputBudgetChars) {
      const isDiff = promptText.includes('diff --git');
      if (isDiff) {
        // Find the last complete hunk boundary that fits
        const cutoff = promptText.lastIndexOf('\ndiff --git', inputBudgetChars);
        const boundary = cutoff > 0 ? cutoff : inputBudgetChars;
        promptText = promptText.slice(0, boundary) +
          '\n\n[... diff truncated — remaining files omitted to fit context window ...]';
      } else {
        const truncMsg = `\n\n[... truncated to fit ${contextWindow}-token context window ...]`;
        promptText = promptText.slice(0, inputBudgetChars - truncMsg.length) + truncMsg;
      }
      process.stderr.write(
        `\n  ⚠️  Input truncated to ~${inputBudgetTokens} tokens to fit context window.\n`
      );
    }

    let completionText = '';

    try {
      completionText = await session.prompt(promptText, {
        maxTokens: maxOutputTokens,
        temperature: request.temperature ?? 0.7,
      });

      const totalTokens = completionText.split(/\s+/).length; // rough estimate

      // Emit the complete response as chunks for streaming compatibility
      const chunkSize = 4;
      for (let i = 0; i < completionText.length; i += chunkSize) {
        yield { delta: completionText.slice(i, i + chunkSize), done: false };
      }

      yield {
        delta: '',
        done: true,
        usage: {
          promptTokens: 0,
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
    const nlc = await import('node-llama-cpp') as unknown as NodeLlamaCppModule;

    const context = await model.createContext();

    // Build tool descriptions for the system prompt.
    // Small models can't do native function-calling; we describe tools in the
    // system prompt and parse JSON out of the response.
    const toolDescriptions = tools.map((t) => {
      const params = Object.entries(t.parameters.properties)
        .map(([name, schema]) => `  - ${name} (${schema.type}): ${schema.description ?? ''}`)
        .join('\n');
      return `Tool: ${t.name}\nDescription: ${t.description}\nParameters:\n${params}`;
    }).join('\n\n');

    const systemPrompt = [
      options.systemPrompt ?? '',
      tools.length > 0
        ? `You have access to the following tools. To call a tool, respond with EXACTLY this JSON format on its own line:\n` +
          `{"tool_call": {"name": "<tool_name>", "arguments": {<args>}}}\n\n` +
          `Available tools:\n${toolDescriptions}`
        : '',
    ].filter(Boolean).join('\n\n');

    // System prompt goes into the session constructor — NEVER prepend it to the
    // user message or the model will echo it back verbatim as its "answer".
    const session: LlamaChatSessionInstance = new nlc.LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: systemPrompt || undefined,
    });

    // Send only the last user message as the prompt.
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    const prompt = lastUserMsg?.content ?? '';

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
