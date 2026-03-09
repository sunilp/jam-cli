import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CompletionRequest, StreamChunk, TokenUsage } from '../providers/base.js';

// We test the class directly, but override the cache dir via a subclass
// to avoid polluting the real cache directory.

import { ResponseCache, cachedCollect } from './response-cache.js';

class TestCache extends ResponseCache {
  constructor(private readonly testDir: string, ttlMs?: number) {
    super(ttlMs);
    // Override the internal dir by patching the private field
    // (we use Object.defineProperty since `dir` is readonly)
    Object.defineProperty(this, 'dir', { value: testDir });
  }
}

function makeRequest(content: string): CompletionRequest {
  return {
    messages: [{ role: 'user', content }],
    model: 'test-model',
    temperature: 0.5,
    systemPrompt: 'You are helpful.',
  };
}

describe('ResponseCache', () => {
  let tempDir: string;
  let cache: TestCache;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'jam-cache-test-'));
    cache = new TestCache(tempDir, 60_000); // 1 minute TTL
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns null for a cache miss', async () => {
    const result = await cache.get('openai', makeRequest('hello'));
    expect(result).toBeNull();
  });

  it('stores and retrieves a cached response', async () => {
    const request = makeRequest('What is TypeScript?');
    const usage: TokenUsage = { promptTokens: 10, completionTokens: 20, totalTokens: 30 };

    await cache.set('openai', request, 'TypeScript is a typed superset of JavaScript.', usage);
    const hit = await cache.get('openai', request);

    expect(hit).not.toBeNull();
    expect(hit!.text).toBe('TypeScript is a typed superset of JavaScript.');
    expect(hit!.usage).toEqual(usage);
    expect(hit!.provider).toBe('openai');
    expect(hit!.model).toBe('test-model');
  });

  it('treats different providers as separate cache keys', async () => {
    const request = makeRequest('hello');
    await cache.set('openai', request, 'response-a');

    const hitOpenAI = await cache.get('openai', request);
    const hitOllama = await cache.get('ollama', request);

    expect(hitOpenAI).not.toBeNull();
    expect(hitOllama).toBeNull();
  });

  it('treats different messages as separate cache keys', async () => {
    await cache.set('openai', makeRequest('hello'), 'greeting');

    const hit = await cache.get('openai', makeRequest('goodbye'));
    expect(hit).toBeNull();
  });

  it('evicts entries past TTL', async () => {
    const shortCache = new TestCache(tempDir, 1); // 1ms TTL
    const request = makeRequest('test');
    await shortCache.set('openai', request, 'expired');

    // Wait for TTL
    await new Promise((r) => setTimeout(r, 10));

    const hit = await shortCache.get('openai', request);
    expect(hit).toBeNull();
  });

  it('clears all entries', async () => {
    await cache.set('a', makeRequest('1'), 'one');
    await cache.set('b', makeRequest('2'), 'two');

    const removed = await cache.clear();
    expect(removed).toBe(2);

    const files = await readdir(tempDir);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('reports stats correctly', async () => {
    await cache.set('openai', makeRequest('a'), 'response-a');
    await cache.set('openai', makeRequest('b'), 'response-b');

    const stats = await cache.stats();
    expect(stats.entries).toBe(2);
    expect(stats.sizeBytes).toBeGreaterThan(0);
    expect(stats.oldestMs).toBeGreaterThan(0);
    expect(stats.newestMs).toBeGreaterThanOrEqual(stats.oldestMs);
  });

  it('returns empty stats for empty cache', async () => {
    const stats = await cache.stats();
    expect(stats).toEqual({ entries: 0, sizeBytes: 0, oldestMs: 0, newestMs: 0 });
  });

  it('prunes expired entries', async () => {
    // Add two entries with a short-lived cache
    const shortCache = new TestCache(tempDir, 1);
    await shortCache.set('a', makeRequest('one'), 'r1');
    await shortCache.set('b', makeRequest('two'), 'r2');

    // Wait for both to expire
    await new Promise((r) => setTimeout(r, 20));

    const pruned = await shortCache.prune();
    expect(pruned).toBe(2);

    // Cache dir should be empty
    const files = await readdir(tempDir);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });
});

// ── cachedCollect ────────────────────────────────────────────────────────────

describe('cachedCollect', () => {
  let tempDir: string;
  let cache: TestCache;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'jam-cache-collect-'));
    cache = new TestCache(tempDir, 60_000);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('calls the stream factory on cache miss and caches the result', async () => {
    let factoryCalled = 0;
    const request = makeRequest('test prompt');

    // eslint-disable-next-line @typescript-eslint/require-await
    async function* fakeStream(): AsyncIterable<StreamChunk> {
      factoryCalled++;
      yield { delta: 'Hello ', done: false };
      yield { delta: 'world', done: false };
      yield { delta: '', done: true, usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } };
    }

    const result = await cachedCollect(cache, 'openai', request, fakeStream);
    expect(result.text).toBe('Hello world');
    expect(result.fromCache).toBe(false);
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 2, totalTokens: 7 });
    expect(factoryCalled).toBe(1);

    // Second call should hit cache
    const result2 = await cachedCollect(cache, 'openai', request, fakeStream);
    expect(result2.text).toBe('Hello world');
    expect(result2.fromCache).toBe(true);
    expect(factoryCalled).toBe(1); // Factory NOT called again
  });

  it('does not cache when stream throws', async () => {
    const request = makeRequest('fail');

    // eslint-disable-next-line @typescript-eslint/require-await
    async function* failStream(): AsyncIterable<StreamChunk> {
      yield { delta: 'partial', done: false };
      throw new Error('network error');
    }

    await expect(cachedCollect(cache, 'openai', request, failStream)).rejects.toThrow('network error');

    // Cache should be empty
    const hit = await cache.get('openai', request);
    expect(hit).toBeNull();
  });
});
