import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

// Mock the SDK availability check to return false (no CLI installed)
vi.mock('./copilot-sdk-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./copilot-sdk-backend.js')>();
  return {
    ...actual,
    isCopilotCliAvailable: vi.fn().mockResolvedValue(false),
  };
});

const PORT = '19879';
const BASE_URL = `http://127.0.0.1:${PORT}`;

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

describe('CopilotAdapter dispatcher', () => {
  it('falls back to proxy when SDK CLI not available', async () => {
    server.use(
      http.get(`${BASE_URL}/health`, () => HttpResponse.json({ status: 'ok' }))
    );

    const { CopilotAdapter } = await import('./copilot.js');
    const adapter = new CopilotAdapter({ baseUrl: BASE_URL });
    await adapter.validateCredentials();
    expect(adapter.info.supportsTools).toBe(false);
  });

  it('streams via proxy backend', async () => {
    server.use(
      http.get(`${BASE_URL}/health`, () => HttpResponse.json({ status: 'ok' })),
      http.post(`${BASE_URL}/v1/chat/completions`, () => {
        const stream = makeSSEStream([
          { id: 'c', choices: [{ delta: { content: 'Hi' }, finish_reason: null }] },
          { id: 'c', choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]);
        return new HttpResponse(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      })
    );

    const { CopilotAdapter } = await import('./copilot.js');
    const adapter = new CopilotAdapter({ baseUrl: BASE_URL });
    await adapter.validateCredentials();

    const chunks = [];
    for await (const chunk of adapter.streamCompletion({ messages: [{ role: 'user', content: 'Hi' }] })) {
      chunks.push(chunk);
    }
    expect(chunks.filter((c) => !c.done).map((c) => c.delta).join('')).toBe('Hi');
  });

  it('throws PROVIDER_UNAVAILABLE when neither backend available', async () => {
    const { CopilotAdapter } = await import('./copilot.js');
    const adapter = new CopilotAdapter({});
    await expect(adapter.validateCredentials()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('throws when chatWithTools called on proxy backend', async () => {
    server.use(
      http.get(`${BASE_URL}/health`, () => HttpResponse.json({ status: 'ok' }))
    );

    const { CopilotAdapter } = await import('./copilot.js');
    const adapter = new CopilotAdapter({ baseUrl: BASE_URL });
    await adapter.validateCredentials();

    await expect(
      adapter.chatWithTools(
        [{ role: 'user', content: 'test' }],
        [{ name: 'test', description: 'test', parameters: { type: 'object', properties: {}, required: [] } }]
      )
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('dispose is safe when no backend', async () => {
    const { CopilotAdapter } = await import('./copilot.js');
    const adapter = new CopilotAdapter({});
    expect(() => adapter.dispose()).not.toThrow();
  });
});
