import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolDefinition } from './base.js';

/**
 * Unit tests for EmbeddedAdapter.
 *
 * Because node-llama-cpp requires native binaries and a downloaded model,
 * these tests mock the heavy imports and verify the adapter's logic: model
 * resolution, error handling, and response parsing.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

// We'll mock node-llama-cpp at the module level so we can control what it returns
const mockPrompt = vi.fn();
const mockDispose = vi.fn();
const mockGetSequence = vi.fn().mockReturnValue({});

const mockCreateContext = vi.fn().mockResolvedValue({
  getSequence: mockGetSequence,
  dispose: mockDispose,
});

const mockLoadModel = vi.fn().mockResolvedValue({
  createContext: mockCreateContext,
});

const mockGetLlama = vi.fn().mockResolvedValue({
  loadModel: mockLoadModel,
});

vi.mock('node-llama-cpp', () => ({
  getLlama: mockGetLlama,
  downloadModel: vi.fn().mockResolvedValue(undefined),
  LlamaChatSession: vi.fn().mockImplementation(() => ({
    prompt: mockPrompt,
  })),
}));

// Mock fs to pretend model files exist
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue(['smollm2-360m-instruct-q4_k_m.gguf']),
  };
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('EmbeddedAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrompt.mockReset();
    // Reset cached state between tests by re-importing fresh
  });

  it('exposes correct provider info', async () => {
    const { EmbeddedAdapter } = await import('./embedded.js');
    const adapter = new EmbeddedAdapter();
    expect(adapter.info.name).toBe('embedded (experimental)');
    expect(adapter.info.supportsStreaming).toBe(true);
  });

  it('validateCredentials boots the model', async () => {
    const { EmbeddedAdapter } = await import('./embedded.js');
    const adapter = new EmbeddedAdapter();
    await adapter.validateCredentials();
    expect(mockGetLlama).toHaveBeenCalled();
    expect(mockLoadModel).toHaveBeenCalled();
  });

  it('listModels returns aliases and cached files', async () => {
    const { EmbeddedAdapter } = await import('./embedded.js');
    const adapter = new EmbeddedAdapter();
    const models = await adapter.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.some((m) => m.includes('smollm2-360m'))).toBe(true);
    expect(models.some((m) => m.includes('cached'))).toBe(true);
  });

  it('streamCompletion yields chunks then done', async () => {
    mockPrompt.mockResolvedValue('Hello, world!');

    const { EmbeddedAdapter } = await import('./embedded.js');
    const adapter = new EmbeddedAdapter();
    const chunks = [];
    for await (const chunk of adapter.streamCompletion({
      messages: [{ role: 'user', content: 'Say hello' }],
    })) {
      chunks.push(chunk);
    }

    const text = chunks.filter((c) => !c.done).map((c) => c.delta).join('');
    expect(text).toBe('Hello, world!');

    const doneChunk = chunks.find((c) => c.done);
    expect(doneChunk).toBeDefined();
    expect(doneChunk!.done).toBe(true);
  });

  it('chatWithTools parses tool call JSON from response', async () => {
    mockPrompt.mockResolvedValue(
      'Let me check that file for you.\n' +
        '{"tool_call": {"name": "read_file", "arguments": {"path": "src/index.ts"}}}'
    );

    const tools: ToolDefinition[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'The file path' },
          },
          required: ['path'],
        },
      },
    ];

    const { EmbeddedAdapter } = await import('./embedded.js');
    const adapter = new EmbeddedAdapter();
    const result = await adapter.chatWithTools(
      [{ role: 'user', content: 'Read src/index.ts' }],
      tools
    );

    expect(result.content).toBe('Let me check that file for you.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe('read_file');
    expect(result.toolCalls![0].arguments).toEqual({ path: 'src/index.ts' });
  });

  it('chatWithTools returns text-only when no tool calls', async () => {
    mockPrompt.mockResolvedValue('I cannot help with that.');

    const { EmbeddedAdapter } = await import('./embedded.js');
    const adapter = new EmbeddedAdapter();
    const result = await adapter.chatWithTools(
      [{ role: 'user', content: 'Tell me a joke' }],
      []
    );

    expect(result.content).toBe('I cannot help with that.');
    expect(result.toolCalls).toBeUndefined();
  });
});
