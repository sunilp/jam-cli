import { describe, it, expect, vi } from 'vitest';
import { ProviderPool } from './provider-pool.js';
import type { ProviderAdapter } from '../providers/base.js';

// Minimal mock adapter
const mockAdapter = {
  info: { name: 'mock', supportsStreaming: true },
  validateCredentials: vi.fn(),
  streamCompletion: vi.fn(),
  listModels: vi.fn(),
} as unknown as ProviderAdapter;

describe('ProviderPool', () => {
  it('acquires and releases leases', async () => {
    const pool = new ProviderPool(mockAdapter, 2);
    const lease1 = await pool.acquire();
    expect(pool.activeCount).toBe(1);
    const lease2 = await pool.acquire();
    expect(pool.activeCount).toBe(2);
    lease1.release();
    expect(pool.activeCount).toBe(1);
    lease2.release();
    expect(pool.activeCount).toBe(0);
  });

  it('queues when at limit', async () => {
    const pool = new ProviderPool(mockAdapter, 1);
    const lease1 = await pool.acquire();
    expect(pool.activeCount).toBe(1);

    // This should queue
    let lease2Resolved = false;
    const lease2Promise = pool.acquire().then(l => { lease2Resolved = true; return l; });

    // Give microtask queue a tick
    await new Promise(r => setTimeout(r, 10));
    expect(lease2Resolved).toBe(false);
    expect(pool.queuedCount).toBe(1);

    // Release lease1 should resolve lease2
    lease1.release();
    const lease2 = await lease2Promise;
    expect(lease2Resolved).toBe(true);
    expect(pool.activeCount).toBe(1);
    lease2.release();
  });

  it('provides adapter through lease', async () => {
    const pool = new ProviderPool(mockAdapter, 1);
    const lease = await pool.acquire();
    expect(lease.adapter).toBe(mockAdapter);
    lease.release();
  });

  it('tracks token usage', () => {
    const pool = new ProviderPool(mockAdapter, 1);
    pool.addTokenUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    pool.addTokenUsage({ promptTokens: 200, completionTokens: 100, totalTokens: 300 });
    const total = pool.getTotalTokens();
    expect(total.promptTokens).toBe(300);
    expect(total.completionTokens).toBe(150);
    expect(total.totalTokens).toBe(450);
  });

  it('pauses for rate limit', async () => {
    const pool = new ProviderPool(mockAdapter, 1);
    pool.pauseForRateLimit(50); // 50ms pause
    const start = Date.now();
    const lease = await pool.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some timing slack
    lease.release();
  });
});
