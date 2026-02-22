import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { OpenAIAdapter } from './openai.js';

const BASE_URL = 'https://api.openai.com';
const API_KEY = 'test-api-key';

function makeSSEStream(events: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('OpenAIAdapter.streamCompletion', () => {
  it('parses SSE stream and yields deltas', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/chat/completions`, () => {
        const stream = makeSSEStream([
          {
            id: 'chatcmpl-1',
            choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-1',
            choices: [{ delta: { content: ' world' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-1',
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          },
        ]);
        return new HttpResponse(stream, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      })
    );

    const adapter = new OpenAIAdapter({ baseUrl: BASE_URL, model: 'gpt-4o-mini', apiKey: API_KEY });
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

  it('throws PROVIDER_AUTH_FAILED on 401', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/chat/completions`, () => {
        return new HttpResponse('Unauthorized', { status: 401 });
      })
    );

    const adapter = new OpenAIAdapter({ baseUrl: BASE_URL, apiKey: API_KEY });
    const iter = adapter.streamCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    await expect(async () => {
      for await (const _chunk of iter) { /* consume */ }
    }).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
  });

  it('throws PROVIDER_MODEL_NOT_FOUND on 404', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/chat/completions`, () => {
        return new HttpResponse('model not found', { status: 404 });
      })
    );

    const adapter = new OpenAIAdapter({ baseUrl: BASE_URL, model: 'nonexistent', apiKey: API_KEY });
    const iter = adapter.streamCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    await expect(async () => {
      for await (const _chunk of iter) { /* consume */ }
    }).rejects.toMatchObject({ code: 'PROVIDER_MODEL_NOT_FOUND' });
  });

  it('throws PROVIDER_RATE_LIMITED on 429', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/chat/completions`, () => {
        return new HttpResponse('rate limited', { status: 429 });
      })
    );

    const adapter = new OpenAIAdapter({ baseUrl: BASE_URL, apiKey: API_KEY });
    const iter = adapter.streamCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    await expect(async () => {
      for await (const _chunk of iter) { /* consume */ }
    }).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
  });

  it('throws PROVIDER_STREAM_ERROR on non-OK response', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/chat/completions`, () => {
        return new HttpResponse('internal error', { status: 500 });
      })
    );

    const adapter = new OpenAIAdapter({ baseUrl: BASE_URL, apiKey: API_KEY });
    const iter = adapter.streamCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    await expect(async () => {
      for await (const _chunk of iter) { /* consume */ }
    }).rejects.toMatchObject({ code: 'PROVIDER_STREAM_ERROR' });
  });

  it('includes system prompt when provided', async () => {
    let capturedBody: unknown;

    server.use(
      http.post(`${BASE_URL}/v1/chat/completions`, async ({ request }) => {
        capturedBody = await request.json();
        const stream = makeSSEStream([
          {
            id: 'chatcmpl-1',
            choices: [{ delta: { content: 'ok' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-1',
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          },
        ]);
        return new HttpResponse(stream, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      })
    );

    const adapter = new OpenAIAdapter({ baseUrl: BASE_URL, model: 'gpt-4o-mini', apiKey: API_KEY });
    for await (const _chunk of adapter.streamCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'You are helpful.',
    })) { /* consume */ }

    const body = capturedBody as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toBe('You are helpful.');
  });
});

describe('OpenAIAdapter.validateCredentials', () => {
  it('resolves when API key is valid', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/models`, () => {
        return HttpResponse.json({ data: [{ id: 'gpt-4o-mini' }] });
      })
    );

    const adapter = new OpenAIAdapter({ baseUrl: BASE_URL, apiKey: API_KEY });
    await expect(adapter.validateCredentials()).resolves.toBeUndefined();
  });

  it('throws PROVIDER_AUTH_FAILED when API key is invalid', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/models`, () => {
        return new HttpResponse('Unauthorized', { status: 401 });
      })
    );

    const adapter = new OpenAIAdapter({ baseUrl: BASE_URL, apiKey: 'bad-key' });
    await expect(adapter.validateCredentials()).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_FAILED',
    });
  });
});

describe('OpenAIAdapter.listModels', () => {
  it('returns sorted model ids', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/models`, () => {
        return HttpResponse.json({
          data: [{ id: 'gpt-4o' }, { id: 'gpt-3.5-turbo' }, { id: 'gpt-4o-mini' }],
        });
      })
    );

    const adapter = new OpenAIAdapter({ baseUrl: BASE_URL, apiKey: API_KEY });
    const models = await adapter.listModels();
    expect(models).toEqual(['gpt-3.5-turbo', 'gpt-4o', 'gpt-4o-mini']);
  });
});

describe('OpenAIAdapter — missing API key', () => {
  it('throws PROVIDER_AUTH_FAILED when no API key is available', () => {
    // Ensure env var is not set
    const saved = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];

    try {
      const adapter = new OpenAIAdapter({ baseUrl: BASE_URL });
      expect(() => adapter['authHeaders']()).toThrow();
    } finally {
      if (saved !== undefined) process.env['OPENAI_API_KEY'] = saved;
    }
  });
});
