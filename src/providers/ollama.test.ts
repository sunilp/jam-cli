import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { OllamaAdapter } from './ollama.js';

const BASE_URL = 'http://localhost:11434';

function makeNDJSONStream(chunks: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(JSON.stringify(chunk) + '\n'));
      }
      controller.close();
    },
  });
}

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('OllamaAdapter.streamCompletion', () => {
  it('parses NDJSON stream and yields deltas', async () => {
    server.use(
      http.post(`${BASE_URL}/api/chat`, () => {
        const stream = makeNDJSONStream([
          {
            model: 'llama3.2',
            created_at: '2024-01-01T00:00:00Z',
            message: { role: 'assistant', content: 'Hello' },
            done: false,
          },
          {
            model: 'llama3.2',
            created_at: '2024-01-01T00:00:00Z',
            message: { role: 'assistant', content: ' world' },
            done: false,
          },
          {
            model: 'llama3.2',
            created_at: '2024-01-01T00:00:00Z',
            message: { role: 'assistant', content: '' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 10,
            eval_count: 5,
          },
        ]);
        return new HttpResponse(stream, {
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      })
    );

    const adapter = new OllamaAdapter({ baseUrl: BASE_URL, model: 'llama3.2' });
    const chunks = [];
    for await (const chunk of adapter.streamCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
    })) {
      chunks.push(chunk);
    }

    const textChunks = chunks.filter((c) => !c.done);
    expect(textChunks.map((c) => c.delta).join('')).toBe('Hello world');

    const doneChunk = chunks.find((c) => c.done);
    expect(doneChunk?.usage?.promptTokens).toBe(10);
    expect(doneChunk?.usage?.completionTokens).toBe(5);
    expect(doneChunk?.usage?.totalTokens).toBe(15);
  });

  it('throws PROVIDER_MODEL_NOT_FOUND on 404', async () => {
    server.use(
      http.post(`${BASE_URL}/api/chat`, () => {
        return new HttpResponse('model not found', { status: 404 });
      })
    );

    const adapter = new OllamaAdapter({ baseUrl: BASE_URL, model: 'nonexistent' });
    const iter = adapter.streamCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    await expect(async () => {
      for await (const _chunk of iter) {
        // consume
      }
    }).rejects.toMatchObject({ code: 'PROVIDER_MODEL_NOT_FOUND' });
  });

  it('throws PROVIDER_STREAM_ERROR on non-OK response', async () => {
    server.use(
      http.post(`${BASE_URL}/api/chat`, () => {
        return new HttpResponse('internal error', { status: 500 });
      })
    );

    const adapter = new OllamaAdapter({ baseUrl: BASE_URL });
    const iter = adapter.streamCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    await expect(async () => {
      for await (const _chunk of iter) {
        // consume
      }
    }).rejects.toMatchObject({ code: 'PROVIDER_STREAM_ERROR' });
  });

  it('includes system prompt when provided', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(`${BASE_URL}/api/chat`, async ({ request }) => {
        capturedBody = await request.json();
        const stream = makeNDJSONStream([
          {
            model: 'llama3.2',
            created_at: '2024-01-01T00:00:00Z',
            message: { role: 'assistant', content: 'ok' },
            done: false,
          },
          {
            model: 'llama3.2',
            created_at: '2024-01-01T00:00:00Z',
            message: { role: 'assistant', content: '' },
            done: true,
            prompt_eval_count: 5,
            eval_count: 2,
          },
        ]);
        return new HttpResponse(stream, {
          headers: { 'Content-Type': 'application/x-ndjson' },
        });
      })
    );

    const adapter = new OllamaAdapter({ baseUrl: BASE_URL, model: 'llama3.2' });
    for await (const _chunk of adapter.streamCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'You are helpful.',
    })) {
      // consume
    }

    const body = capturedBody as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toBe('You are helpful.');
  });
});

describe('OllamaAdapter.validateCredentials', () => {
  it('resolves when Ollama is reachable', async () => {
    server.use(
      http.get(`${BASE_URL}/api/tags`, () => {
        return HttpResponse.json({ models: [] });
      })
    );

    const adapter = new OllamaAdapter({ baseUrl: BASE_URL });
    await expect(adapter.validateCredentials()).resolves.toBeUndefined();
  });

  it('throws PROVIDER_UNAVAILABLE when Ollama not reachable', async () => {
    server.use(
      http.get(`${BASE_URL}/api/tags`, () => {
        return new HttpResponse(null, { status: 503 });
      })
    );

    const adapter = new OllamaAdapter({ baseUrl: BASE_URL });
    await expect(adapter.validateCredentials()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });
});
