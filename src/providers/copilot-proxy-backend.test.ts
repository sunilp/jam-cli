import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { CopilotProxyBackend } from './copilot-proxy-backend.js';

const BASE_URL = 'http://127.0.0.1:19878';

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

describe('CopilotProxyBackend', () => {
  it('has correct provider info', () => {
    const backend = new CopilotProxyBackend({ baseUrl: BASE_URL });
    expect(backend.info.name).toBe('copilot');
    expect(backend.info.supportsStreaming).toBe(true);
    expect(backend.info.supportsTools).toBe(true);
  });

  it('validates credentials via /health endpoint', async () => {
    server.use(
      http.get(`${BASE_URL}/health`, () => {
        return HttpResponse.json({ status: 'ok' });
      })
    );

    const backend = new CopilotProxyBackend({ baseUrl: BASE_URL });
    await expect(backend.validateCredentials()).resolves.toBeUndefined();
  });

  it('throws PROVIDER_UNAVAILABLE when health check fails', async () => {
    server.use(
      http.get(`${BASE_URL}/health`, () => {
        return HttpResponse.error();
      })
    );

    const backend = new CopilotProxyBackend({ baseUrl: BASE_URL });
    await expect(backend.validateCredentials()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('streams completions without auth header', async () => {
    let capturedHeaders: Headers | undefined;

    server.use(
      http.post(`${BASE_URL}/v1/chat/completions`, ({ request }) => {
        capturedHeaders = request.headers;
        const stream = makeSSEStream([
          {
            id: 'chatcmpl-proxy',
            choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-proxy',
            choices: [{ delta: { content: ' world' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-proxy',
            choices: [{ delta: {}, finish_reason: 'stop' }],
          },
        ]);
        return new HttpResponse(stream, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      })
    );

    const backend = new CopilotProxyBackend({ baseUrl: BASE_URL });
    const chunks = [];
    for await (const chunk of backend.streamCompletion({
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      chunks.push(chunk);
    }

    const textChunks = chunks.filter((c) => !c.done);
    expect(textChunks.map((c) => c.delta).join('')).toBe('Hello world');

    // Verify no Authorization header was sent
    expect(capturedHeaders?.get('authorization')).toBeNull();
    expect(capturedHeaders?.get('content-type')).toBe('application/json');
  });

  it('lists models from proxy server', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/models`, () => {
        return HttpResponse.json({
          data: [
            { id: 'copilot-gpt-4o' },
            { id: 'copilot-claude-3.5-sonnet' },
          ],
        });
      })
    );

    const backend = new CopilotProxyBackend({ baseUrl: BASE_URL });
    const models = await backend.listModels();
    expect(models).toEqual(['copilot-claude-3.5-sonnet', 'copilot-gpt-4o']);
  });
});
