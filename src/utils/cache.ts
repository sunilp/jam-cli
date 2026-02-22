/**
 * Tool result cache — avoids redundant file reads and searches within a session.
 *
 * Keyed by (toolName, JSON.stringify(args)).  File reads are invalidated
 * if a write_file or apply_patch call modifies the same path.
 */

export class ToolResultCache {
  private cache = new Map<string, { output: string; timestamp: number }>();

  /** TTL in ms — stale results are evicted (default: 5 minutes). */
  private ttl: number;

  constructor(ttlMs: number = 5 * 60 * 1000) {
    this.ttl = ttlMs;
  }

  private key(name: string, args: Record<string, unknown>): string {
    return `${name}:${JSON.stringify(args, Object.keys(args).sort())}`;
  }

  /**
   * Get a cached result.  Returns `null` if not found or expired.
   */
  get(name: string, args: Record<string, unknown>): string | null {
    const k = this.key(name, args);
    const entry = this.cache.get(k);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(k);
      return null;
    }
    return entry.output;
  }

  /**
   * Store a tool result.
   */
  set(name: string, args: Record<string, unknown>, output: string): void {
    const k = this.key(name, args);
    this.cache.set(k, { output, timestamp: Date.now() });
  }

  /**
   * Invalidate cached reads for a file path (called after write/patch operations).
   */
  invalidatePath(filePath: string): void {
    for (const [k] of this.cache) {
      // Invalidate any read_file cache entries that match this path
      if (k.startsWith('read_file:') && k.includes(filePath)) {
        this.cache.delete(k);
      }
      // Also invalidate search_text since file contents changed
      if (k.startsWith('search_text:')) {
        this.cache.delete(k);
      }
    }
  }

  /** Number of cached entries. */
  get size(): number {
    return this.cache.size;
  }

  /** Clear all cached results. */
  clear(): void {
    this.cache.clear();
  }
}
