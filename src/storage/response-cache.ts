/**
 * File-based response cache for LLM completions.
 *
 * Keyed by SHA-256 hash of (provider, model, messages, temperature, systemPrompt).
 * Each entry is a small JSON file: { text, usage, createdAt }.
 * Entries older than TTL are treated as stale and evicted lazily.
 */

import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { CompletionRequest, StreamChunk, TokenUsage } from '../providers/base.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CacheEntry {
  text: string;
  usage?: TokenUsage;
  createdAt: number;
  provider: string;
  model: string;
}

export interface CacheStats {
  entries: number;
  sizeBytes: number;
  oldestMs: number;
  newestMs: number;
}

// ── Cache directory ──────────────────────────────────────────────────────────

function getCacheDir(): string {
  const platform = process.platform;
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'jam', 'cache');
  }
  if (platform === 'win32') {
    return join(process.env['APPDATA'] ?? homedir(), 'jam', 'cache');
  }
  return join(process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'), 'jam', 'responses');
}

// ── ResponseCache ────────────────────────────────────────────────────────────

export class ResponseCache {
  private readonly dir: string;
  private readonly ttlMs: number;

  constructor(ttlMs: number = 60 * 60 * 1000) {
    this.dir = getCacheDir();
    this.ttlMs = ttlMs;
  }

  /**
   * Build a deterministic cache key from a completion request + provider name.
   */
  private buildKey(provider: string, request: CompletionRequest): string {
    const payload = JSON.stringify({
      provider,
      model: request.model ?? '',
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: request.temperature ?? 0,
      systemPrompt: request.systemPrompt ?? '',
    });
    return createHash('sha256').update(payload).digest('hex');
  }

  private filePath(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  /**
   * Look up a cached response. Returns null if not found or expired.
   */
  async get(provider: string, request: CompletionRequest): Promise<CacheEntry | null> {
    const key = this.buildKey(provider, request);
    try {
      const raw = await readFile(this.filePath(key), 'utf-8');
      const entry = JSON.parse(raw) as CacheEntry;
      if (Date.now() - entry.createdAt > this.ttlMs) {
        // Stale — delete lazily
        unlink(this.filePath(key)).catch(() => {});
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * Store a response in the cache.
   */
  async set(
    provider: string,
    request: CompletionRequest,
    text: string,
    usage?: TokenUsage,
  ): Promise<void> {
    const key = this.buildKey(provider, request);
    const entry: CacheEntry = {
      text,
      usage,
      createdAt: Date.now(),
      provider,
      model: request.model ?? '',
    };
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.filePath(key), JSON.stringify(entry), 'utf-8');
    } catch {
      // Non-fatal — caching is best-effort
    }
  }

  /**
   * Delete all cached responses. Returns number of entries removed.
   */
  async clear(): Promise<number> {
    try {
      const files = await readdir(this.dir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));
      await Promise.all(jsonFiles.map((f) => unlink(join(this.dir, f)).catch(() => {})));
      return jsonFiles.length;
    } catch {
      return 0;
    }
  }

  /**
   * Gather cache statistics.
   */
  async stats(): Promise<CacheStats> {
    try {
      const files = await readdir(this.dir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));
      if (jsonFiles.length === 0) {
        return { entries: 0, sizeBytes: 0, oldestMs: 0, newestMs: 0 };
      }

      let sizeBytes = 0;
      let oldest = Infinity;
      let newest = 0;

      for (const f of jsonFiles) {
        try {
          const s = await stat(join(this.dir, f));
          sizeBytes += s.size;
          oldest = Math.min(oldest, s.mtimeMs);
          newest = Math.max(newest, s.mtimeMs);
        } catch { /* skip */ }
      }

      return {
        entries: jsonFiles.length,
        sizeBytes,
        oldestMs: oldest === Infinity ? 0 : oldest,
        newestMs: newest,
      };
    } catch {
      return { entries: 0, sizeBytes: 0, oldestMs: 0, newestMs: 0 };
    }
  }

  /**
   * Remove entries older than TTL. Returns number of entries pruned.
   */
  async prune(): Promise<number> {
    try {
      const files = await readdir(this.dir);
      const jsonFiles = files.filter((f) => f.endsWith('.json'));
      let pruned = 0;
      const now = Date.now();

      for (const f of jsonFiles) {
        try {
          const raw = await readFile(join(this.dir, f), 'utf-8');
          const entry = JSON.parse(raw) as CacheEntry;
          if (now - entry.createdAt > this.ttlMs) {
            await unlink(join(this.dir, f));
            pruned++;
          }
        } catch {
          // Corrupted entry — delete it
          await unlink(join(this.dir, f)).catch(() => {});
          pruned++;
        }
      }

      return pruned;
    } catch {
      return 0;
    }
  }
}

// ── Cached stream wrapper ────────────────────────────────────────────────────

/**
 * Wrap a `collectStream` call with response caching.
 * On cache hit: returns the cached text immediately (no API call).
 * On cache miss: calls the stream factory, collects the result, caches it, returns it.
 */
export async function cachedCollect(
  cache: ResponseCache,
  provider: string,
  request: CompletionRequest,
  streamFactory: () => AsyncIterable<StreamChunk>,
): Promise<{ text: string; usage?: TokenUsage; fromCache: boolean }> {
  // Check cache
  const hit = await cache.get(provider, request);
  if (hit) {
    return { text: hit.text, usage: hit.usage, fromCache: true };
  }

  // Miss — stream and collect
  let text = '';
  let usage: TokenUsage | undefined;
  for await (const chunk of streamFactory()) {
    if (chunk.done) {
      usage = chunk.usage;
    } else {
      text += chunk.delta;
    }
  }

  // Store in cache (best-effort, awaited for consistency)
  await cache.set(provider, request, text, usage);

  return { text, usage, fromCache: false };
}
