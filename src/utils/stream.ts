import type { StreamChunk } from '../providers/base.js';
import { JamError } from './errors.js';

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calcDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  // Exponential backoff with jitter
  const exp = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  return exp * (0.5 + 0.5 * Math.random());
}

export async function* withRetry(
  factory: () => AsyncIterable<StreamChunk>,
  options: Partial<RetryOptions> = {}
): AsyncIterable<StreamChunk> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = calcDelay(attempt - 1, opts.baseDelayMs, opts.maxDelayMs);
      await sleep(delay);
    }

    try {
      yield* factory();
      return;
    } catch (err) {
      lastError = err;
      const jamErr = err instanceof JamError ? err : null;

      if (!jamErr?.retryable) {
        throw err;
      }

      if (attempt < opts.maxAttempts - 1) {
        // Will retry
        continue;
      }
    }
  }

  throw lastError;
}

export async function collectStream(stream: AsyncIterable<StreamChunk>): Promise<{
  text: string;
  usage?: StreamChunk['usage'];
}> {
  let text = '';
  let usage: StreamChunk['usage'];

  for await (const chunk of stream) {
    if (chunk.done) {
      usage = chunk.usage;
    } else {
      text += chunk.delta;
    }
  }

  return { text, usage };
}
