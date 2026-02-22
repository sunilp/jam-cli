import { describe, it, expect } from 'vitest';
import { withRetry, collectStream } from './stream.js';
import { JamError } from './errors.js';
import type { StreamChunk } from '../providers/base.js';

function makeChunks(texts: string[]): StreamChunk[] {
  return [
    ...texts.map((t) => ({ delta: t, done: false as const })),
    {
      delta: '',
      done: true as const,
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    },
  ];
}

async function* fromChunks(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) {
    yield await Promise.resolve(chunk);
  }
}

describe('collectStream', () => {
  it('collects all deltas into text', async () => {
    const result = await collectStream(fromChunks(makeChunks(['Hello', ' ', 'world'])));
    expect(result.text).toBe('Hello world');
    expect(result.usage?.totalTokens).toBe(8);
  });

  it('returns empty text for empty stream', async () => {
    const result = await collectStream(fromChunks([{ delta: '', done: true }]));
    expect(result.text).toBe('');
  });
});

describe('withRetry', () => {
  it('yields chunks on first success', async () => {
    const factory = () => fromChunks(makeChunks(['ok']));
    const result = await collectStream(withRetry(factory));
    expect(result.text).toBe('ok');
  });

  it('retries on retryable JamError and succeeds', async () => {
    let attempts = 0;
    const factory = (): AsyncIterable<StreamChunk> => {
      attempts++;
      if (attempts < 3) {
        throw new JamError('temporary failure', 'PROVIDER_UNAVAILABLE', { retryable: true });
      }
      return fromChunks(makeChunks(['success']));
    };

    const result = await collectStream(
      withRetry(factory, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 })
    );
    expect(result.text).toBe('success');
    expect(attempts).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    let attempts = 0;
    const factory = (): AsyncIterable<StreamChunk> => {
      attempts++;
      throw new JamError('fatal error', 'CONFIG_INVALID', { retryable: false });
    };

    await expect(
      collectStream(withRetry(factory, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10 }))
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

    expect(attempts).toBe(1);
  });

  it('exhausts retries and throws last error', async () => {
    let attempts = 0;
    const factory = (): AsyncIterable<StreamChunk> => {
      attempts++;
      throw new JamError('always fails', 'PROVIDER_UNAVAILABLE', { retryable: true });
    };

    await expect(
      collectStream(withRetry(factory, { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 10 }))
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });

    expect(attempts).toBe(2);
  });
});
