import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { GroqAdapter } from './groq.js';

const GROQ_BASE_URL = 'https://api.groq.com/openai';
const API_KEY = 'test-groq-api-key';

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

describe('GroqAdapter', () => {
  it('has correct provider name', () => {
    const adapter = new GroqAdapter({ apiKey: API_KEY });
    expect(adapter.info.name).toBe('groq');
    expect(adapter.info.supportsStreaming).toBe(true);
  });

  it('streams completions via Groq API', async () => {
    server.use(
      http.post(`${GROQ_BASE_URL}/v1/chat/completions`, () => {
        const stream = makeSSEStream([
          {
            id: 'chatcmpl-groq',
            choices: [{ delta: { content: 'Fast' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-groq',
            choices: [{ delta: { content: ' inference' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-groq',
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
          },
        ]);
        return new HttpResponse(stream, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      })
    );

    const adapter = new GroqAdapter({ apiKey: API_KEY });
    const chunks = [];
    for await (const chunk of adapter.streamCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
    })) {
      chunks.push(chunk);
    }

    const textChunks = chunks.filter((c) => !c.done);
    expect(textChunks.map((c) => c.delta).join('')).toBe('Fast inference');
  });

  it('resolves validateCredentials when API key is valid', async () => {
    server.use(
      http.get(`${GROQ_BASE_URL}/v1/models`, () => {
        return HttpResponse.json({ data: [{ id: 'llama3-8b-8192' }] });
      })
    );

    const adapter = new GroqAdapter({ apiKey: API_KEY });
    await expect(adapter.validateCredentials()).resolves.toBeUndefined();
  });

  it('reads API key from GROQ_API_KEY env var', () => {
    const saved = process.env['GROQ_API_KEY'];
    process.env['GROQ_API_KEY'] = 'env-groq-key';
    try {
      const adapter = new GroqAdapter();
      // Access private field through bracket notation to verify key is set
      expect(adapter['apiKey']).toBe('env-groq-key');
    } finally {
      if (saved !== undefined) {
        process.env['GROQ_API_KEY'] = saved;
      } else {
        delete process.env['GROQ_API_KEY'];
      }
    }
  });
});
