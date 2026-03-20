import type { ProviderAdapter, TokenUsage } from '../providers/base.js';

export interface ProviderLease {
  adapter: ProviderAdapter;
  /** Call when done with this lease to release the semaphore slot */
  release(): void;
}

export class ProviderPool {
  private adapter: ProviderAdapter;
  private limit: number;
  private active = 0;
  private queue: Array<(lease: ProviderLease) => void> = [];
  private totalTokens: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private rateLimitPauseUntil = 0;

  constructor(adapter: ProviderAdapter, concurrencyLimit: number = 3) {
    this.adapter = adapter;
    this.limit = concurrencyLimit;
  }

  /** Acquire a lease. Blocks (via promise) if at concurrency limit or rate-limited. */
  async acquire(): Promise<ProviderLease> {
    // If rate limited, wait until cooldown expires
    const now = Date.now();
    if (this.rateLimitPauseUntil > now) {
      await new Promise(resolve => setTimeout(resolve, this.rateLimitPauseUntil - now));
    }

    if (this.active < this.limit) {
      this.active++;
      return this.createLease();
    }

    // At limit — queue the request
    return new Promise<ProviderLease>(resolve => {
      this.queue.push(resolve);
    });
  }

  /** Pause all acquires for rate limiting */
  pauseForRateLimit(retryAfterMs: number): void {
    this.rateLimitPauseUntil = Date.now() + retryAfterMs;
  }

  /** Add to aggregate token usage */
  addTokenUsage(usage: TokenUsage): void {
    this.totalTokens.promptTokens += usage.promptTokens;
    this.totalTokens.completionTokens += usage.completionTokens;
    this.totalTokens.totalTokens += usage.totalTokens;
  }

  /** Get aggregate token usage across all leases */
  getTotalTokens(): TokenUsage {
    return { ...this.totalTokens };
  }

  get activeCount(): number { return this.active; }
  get queuedCount(): number { return this.queue.length; }

  private createLease(): ProviderLease {
    return {
      adapter: this.adapter,
      release: () => {
        this.active--;
        const next = this.queue.shift();
        if (next) {
          this.active++;
          next(this.createLease());
        }
      },
    };
  }
}
