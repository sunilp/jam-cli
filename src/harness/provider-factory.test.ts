import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/loader.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({}),
  getActiveProfile: vi.fn().mockReturnValue({ provider: 'ollama', model: 'llama3.2' }),
}));

vi.mock('../providers/factory.js', () => ({
  createProvider: vi.fn(),
}));

import { AdaptedProvider, createHarnessProvider } from './provider-factory.js';
import { createProvider } from '../providers/factory.js';
import type { ProviderAdapter } from '../providers/base.js';
import type { ModelRequest } from './model.js';

function baseAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    info: { name: 'fake', supportsStreaming: false, supportsTools: true },
    validateCredentials: () => Promise.resolve(),
    streamCompletion: () => (async function* () { /* unused */ })(),
    listModels: () => Promise.resolve([]),
    ...overrides,
  };
}

function req(messages: ModelRequest['messages']): ModelRequest {
  return { messages, tools: [] };
}

describe('AdaptedProvider.generate — abort race', () => {
  it('resolves promptly on abort instead of waiting for chatWithTools, ' +
     'which keeps running in the background', async () => {
    let backgroundSettled = false;
    let releaseChat: (() => void) | undefined;
    const chatGate = new Promise<void>((resolve) => { releaseChat = resolve; });

    const adapter = baseAdapter({
      chatWithTools: async () => {
        await chatGate; // never resolves until the test releases it
        backgroundSettled = true;
        return { content: 'too late', toolCalls: [] };
      },
    });

    const provider = new AdaptedProvider(adapter, 'fake', 'fake-model');
    const ac = new AbortController();

    const genPromise = provider.generate(req([{ role: 'user', content: 'hi' }]), ac.signal);
    ac.abort();
    const result = await genPromise;

    expect(result).toEqual({ content: null, toolCalls: [] });
    // The underlying call must still be in flight, not cancelled -- generate()
    // resolving does not mean the real HTTP request stopped.
    expect(backgroundSettled).toBe(false);

    // Clean up: release the gate so nothing is left dangling after the test.
    releaseChat?.();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('resolves immediately when the signal is already aborted before generate is called', async () => {
    const adapter = baseAdapter({
      chatWithTools: () => new Promise(() => { /* never resolves */ }),
    });
    const provider = new AdaptedProvider(adapter, 'fake', 'fake-model');
    const ac = new AbortController();
    ac.abort();

    const result = await provider.generate(req([{ role: 'user', content: 'hi' }]), ac.signal);
    expect(result).toEqual({ content: null, toolCalls: [] });
  });

  it('does not raise an unhandled rejection when the background call later rejects', async () => {
    const adapter = baseAdapter({
      chatWithTools: async () => {
        await new Promise((r) => setTimeout(r, 5));
        throw new Error('network died after we stopped listening');
      },
    });
    const provider = new AdaptedProvider(adapter, 'fake', 'fake-model');
    const ac = new AbortController();

    const genPromise = provider.generate(req([{ role: 'user', content: 'hi' }]), ac.signal);
    ac.abort();
    const result = await genPromise;
    expect(result).toEqual({ content: null, toolCalls: [] });

    // Give the background rejection a chance to surface; if it were
    // unhandled, vitest/node would report it. Absence of a thrown/uncaught
    // error here is the assertion.
    await new Promise((r) => setTimeout(r, 20));
  });
});

describe('AdaptedProvider.generate — message normalization', () => {
  it('remaps the tool role to user, since jam\'s Message type has no tool role', async () => {
    let seen: unknown;
    const adapter = baseAdapter({
      chatWithTools: (messages) => {
        seen = messages;
        return Promise.resolve({ content: 'ok', toolCalls: [] });
      },
    });
    const provider = new AdaptedProvider(adapter, 'fake', 'fake-model');

    await provider.generate(
      req([
        { role: 'system', content: 'sys' },
        { role: 'tool', content: 'tool result payload' },
        { role: 'assistant', content: 'asst' },
      ]),
      new AbortController().signal
    );

    expect(seen).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'tool result payload' },
      { role: 'assistant', content: 'asst' },
    ]);
  });

  it('falls back to the array index when a tool call has no id', async () => {
    const adapter = baseAdapter({
      chatWithTools: () => Promise.resolve({
        content: null,
        toolCalls: [
          { name: 'has_id', arguments: { a: 1 }, id: 'real-id' },
          { name: 'missing_id', arguments: { b: 2 } },
        ],
      }),
    });
    const provider = new AdaptedProvider(adapter, 'fake', 'fake-model');

    const result = await provider.generate(
      req([{ role: 'user', content: 'hi' }]), new AbortController().signal
    );

    expect(result.toolCalls).toEqual([
      { id: 'real-id', name: 'has_id', arguments: { a: 1 } },
      { id: '1', name: 'missing_id', arguments: { b: 2 } },
    ]);
  });
});

describe('createHarnessProvider — tool-support guard', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('rejects a provider without chatWithTools, since the loop has no ' +
     'text-only fallback', async () => {
    vi.mocked(createProvider).mockResolvedValue(
      baseAdapter({ info: { name: 'no-tools', supportsStreaming: false, supportsTools: true } })
      // chatWithTools intentionally omitted
    );
    await expect(createHarnessProvider({})).rejects.toThrow(/does not support tool calling/);
  });

  it('rejects a provider whose info.supportsTools is false even if ' +
     'chatWithTools happens to be present', async () => {
    vi.mocked(createProvider).mockResolvedValue(
      baseAdapter({
        info: { name: 'declared-no-tools', supportsStreaming: false, supportsTools: false },
        chatWithTools: () => Promise.resolve({ content: 'x', toolCalls: [] }),
      })
    );
    await expect(createHarnessProvider({})).rejects.toThrow(/does not support tool calling/);
  });

  it('accepts a provider that supports tools', async () => {
    vi.mocked(createProvider).mockResolvedValue(
      baseAdapter({
        info: { name: 'ok', supportsStreaming: false, supportsTools: true },
        chatWithTools: () => Promise.resolve({ content: 'x', toolCalls: [] }),
      })
    );
    const provider = await createHarnessProvider({});
    expect(provider.name).toBe('ok');
  });
});
