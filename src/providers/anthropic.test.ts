import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { AnthropicAdapter } from './anthropic.js';

const BASE_URL = 'https://api.anthropic.com';

function makeSSEStream(events: Array<{ type: string; data: object }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`));
      }
      controller.close();
    },
  });
}

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('AnthropicAdapter.streamCompletion', () => {
  it('parses SSE stream and yields deltas', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/messages`, () => {
        const stream = makeSSEStream([
          {
            type: 'message_start',
            data: {
              type: 'message_start',
              message: { id: 'msg_1', usage: { input_tokens: 10, output_tokens: 0 } },
            },
          },
          {
            type: 'content_block_start',
            data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          },
          {
            type: 'content_block_delta',
            data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
          },
          {
            type: 'content_block_delta',
            data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
          },
          {
            type: 'content_block_stop',
            data: { type: 'content_block_stop', index: 0 },
          },
          {
            type: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          },
          {
            type: 'message_stop',
            data: { type: 'message_stop' },
          },
        ]);
        return new HttpResponse(stream, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      })
    );

    const adapter = new AnthropicAdapter({ baseUrl: BASE_URL, apiKey: 'sk-test-key' });
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

  it('throws PROVIDER_AUTH_FAILED when no API key set', async () => {
    const adapter = new AnthropicAdapter({ baseUrl: BASE_URL });
    await expect(async () => {
      for await (const _chunk of adapter.streamCompletion({
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        // consume
      }
    }).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
  });

  it('throws PROVIDER_AUTH_FAILED on 401', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/messages`, () => {
        return new HttpResponse('invalid api key', { status: 401 });
      })
    );

    const adapter = new AnthropicAdapter({ baseUrl: BASE_URL, apiKey: 'sk-bad' });
    const iter = adapter.streamCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    await expect(async () => {
      for await (const _chunk of iter) {
        // consume
      }
    }).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
  });

  it('throws PROVIDER_MODEL_NOT_FOUND on 404', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/messages`, () => {
        return new HttpResponse('model not found', { status: 404 });
      })
    );

    const adapter = new AnthropicAdapter({ baseUrl: BASE_URL, apiKey: 'sk-test', model: 'nonexistent' });
    const iter = adapter.streamCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    await expect(async () => {
      for await (const _chunk of iter) {
        // consume
      }
    }).rejects.toMatchObject({ code: 'PROVIDER_MODEL_NOT_FOUND' });
  });

  it('throws PROVIDER_RATE_LIMITED on 429', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/messages`, () => {
        return new HttpResponse('rate limited', { status: 429 });
      })
    );

    const adapter = new AnthropicAdapter({ baseUrl: BASE_URL, apiKey: 'sk-test' });
    const iter = adapter.streamCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    await expect(async () => {
      for await (const _chunk of iter) {
        // consume
      }
    }).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
  });

  it('includes system prompt as top-level field', async () => {
    let capturedBody: Record<string, unknown> | undefined;

    server.use(
      http.post(`${BASE_URL}/v1/messages`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        const stream = makeSSEStream([
          {
            type: 'content_block_delta',
            data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          },
          {
            type: 'message_delta',
            data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 2 } },
          },
        ]);
        return new HttpResponse(stream, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      })
    );

    const adapter = new AnthropicAdapter({ baseUrl: BASE_URL, apiKey: 'sk-test' });
    for await (const _chunk of adapter.streamCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'You are helpful.',
    })) {
      // consume
    }

    expect(capturedBody?.system).toBe('You are helpful.');
    // System prompt should NOT be in messages
    const msgs = capturedBody?.messages as Array<{ role: string }>;
    expect(msgs.every((m) => m.role !== 'system')).toBe(true);
  });
});

describe('AnthropicAdapter.chatWithTools', () => {
  it('parses tool_use content blocks into tool calls', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/messages`, () => {
        return HttpResponse.json({
          id: 'msg_1',
          content: [
            { type: 'text', text: 'Let me read the file.' },
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'read_file',
              input: { path: 'src/index.ts' },
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 50 },
        });
      })
    );

    const adapter = new AnthropicAdapter({ baseUrl: BASE_URL, apiKey: 'sk-test' });
    const result = await adapter.chatWithTools(
      [{ role: 'user', content: 'read index.ts' }],
      [
        {
          name: 'read_file',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'File path' } },
            required: ['path'],
          },
        },
      ]
    );

    expect(result.content).toBe('Let me read the file.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe('read_file');
    expect(result.toolCalls![0]!.arguments).toEqual({ path: 'src/index.ts' });
    expect(result.toolCalls![0]!.id).toBe('toolu_1');
    expect(result.usage?.promptTokens).toBe(100);
    expect(result.usage?.completionTokens).toBe(50);
  });

  it('returns text-only when no tool calls', async () => {
    server.use(
      http.post(`${BASE_URL}/v1/messages`, () => {
        return HttpResponse.json({
          id: 'msg_2',
          content: [{ type: 'text', text: 'The answer is 42.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 20, output_tokens: 10 },
        });
      })
    );

    const adapter = new AnthropicAdapter({ baseUrl: BASE_URL, apiKey: 'sk-test' });
    const result = await adapter.chatWithTools(
      [{ role: 'user', content: 'what is the answer' }],
      []
    );

    expect(result.content).toBe('The answer is 42.');
    expect(result.toolCalls).toBeUndefined();
  });

  it('sends tools in Anthropic format', async () => {
    let capturedBody: Record<string, unknown> | undefined;

    server.use(
      http.post(`${BASE_URL}/v1/messages`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: 'msg_3',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      })
    );

    const adapter = new AnthropicAdapter({ baseUrl: BASE_URL, apiKey: 'sk-test' });
    await adapter.chatWithTools(
      [{ role: 'user', content: 'test' }],
      [
        {
          name: 'search_text',
          description: 'Search files',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
              glob: { type: 'string', description: 'File pattern' },
            },
            required: ['query'],
          },
        },
      ]
    );

    const tools = capturedBody?.tools as Array<{ name: string; input_schema: unknown }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('search_text');
    // Anthropic uses input_schema, not parameters
    expect(tools[0]!.input_schema).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        glob: { type: 'string', description: 'File pattern' },
      },
      required: ['query'],
    });
  });
});

describe('AnthropicAdapter.validateCredentials', () => {
  it('resolves when API key is valid', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/models`, () => {
        return HttpResponse.json({ data: [{ id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' }], has_more: false });
      })
    );

    const adapter = new AnthropicAdapter({ baseUrl: BASE_URL, apiKey: 'sk-test' });
    await expect(adapter.validateCredentials()).resolves.toBeUndefined();
  });

  it('throws PROVIDER_AUTH_FAILED on 401', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/models`, () => {
        return new HttpResponse('unauthorized', { status: 401 });
      })
    );

    const adapter = new AnthropicAdapter({ baseUrl: BASE_URL, apiKey: 'sk-bad' });
    await expect(adapter.validateCredentials()).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_FAILED',
    });
  });
});
