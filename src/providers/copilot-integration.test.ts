import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { CopilotProxyBackend } from './copilot-proxy-backend.js';
import { createMockCopilotServer } from './copilot-mock-server.js';
import type { ToolDefinition } from './base.js';
import type * as CopilotSdkBackendModule from './copilot-sdk-backend.js';

vi.mock('./copilot-sdk-backend.js', async () => {
  const actual = await vi.importActual<typeof CopilotSdkBackendModule>('./copilot-sdk-backend.js');
  return { ...actual, isCopilotCliAvailable: vi.fn().mockResolvedValue(false) };
});

// ── Block 1: tool calling ─────────────────────────────────────────────────────

describe('CopilotProxyBackend integration (tool calling)', () => {
  let port: number;
  const mockServer = createMockCopilotServer('tool_calls');

  beforeAll(async () => {
    port = await mockServer.start();
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  it('sends tool schemas in request and receives parsed tool call response', async () => {
    const backend = new CopilotProxyBackend({ baseUrl: `http://127.0.0.1:${port}` });

    const tools: ToolDefinition[] = [
      {
        name: 'list_dir',
        description: 'List files in a directory',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to list' },
          },
          required: ['path'],
        },
      },
    ];

    const response = await backend.chatWithTools(
      [{ role: 'user', content: 'List the current directory' }],
      tools
    );

    // Verify tool call was returned and parsed correctly
    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls).toHaveLength(1);

    const toolCall = response.toolCalls![0]!;
    expect(toolCall.name).toBe('list_dir');
    expect(toolCall.id).toBe('call_abc123');
    expect(toolCall.arguments).toEqual({ path: '.' });

    // Content should be null when tool_calls are returned
    expect(response.content).toBeNull();

    // Verify the request body sent to the server contained the tool schemas
    const recorded = mockServer.getRequests();
    const completionsRequest = recorded.find((r) => r.url === '/v1/chat/completions');
    expect(completionsRequest).toBeDefined();

    const body = completionsRequest!.body as {
      tools: Array<{ type: string; function: { name: string } }>;
      messages: Array<{ role: string; content: string }>;
    };

    expect(body.tools).toBeDefined();
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]!.type).toBe('function');
    expect(body.tools[0]!.function.name).toBe('list_dir');
    expect(body.messages.some((m) => m.role === 'user')).toBe(true);
  });

  it('validates credentials via /health endpoint', async () => {
    const backend = new CopilotProxyBackend({ baseUrl: `http://127.0.0.1:${port}` });
    await expect(backend.validateCredentials()).resolves.toBeUndefined();

    const recorded = mockServer.getRequests();
    const healthRequest = recorded.find((r) => r.url === '/health');
    expect(healthRequest).toBeDefined();
    expect(healthRequest!.method).toBe('GET');
  });

  it('lists models from the mock server', async () => {
    const backend = new CopilotProxyBackend({ baseUrl: `http://127.0.0.1:${port}` });
    const models = await backend.listModels();

    expect(models).toContain('copilot-gpt-4o');
    expect(models).toContain('copilot-claude-3.5-sonnet');
    // listModels sorts alphabetically
    expect(models).toEqual([...models].sort());
  });
});

// ── Block 2: text response ────────────────────────────────────────────────────

describe('CopilotProxyBackend integration (text response)', () => {
  let port: number;
  const mockServer = createMockCopilotServer('text_response');

  beforeAll(async () => {
    port = await mockServer.start();
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  it('returns text content with no tool calls and correct usage stats', async () => {
    const backend = new CopilotProxyBackend({ baseUrl: `http://127.0.0.1:${port}` });

    const response = await backend.chatWithTools!(
      [{ role: 'user', content: 'Say hello' }],
      [] // no tools — plain text scenario
    );

    // Content should be the text returned by the mock
    expect(response.content).toBe('Hello from the mock Copilot server!');

    // No tool calls in a text-only response
    expect(response.toolCalls).toBeUndefined();

    // Usage stats should be present and correct
    expect(response.usage).toBeDefined();
    expect(response.usage!.promptTokens).toBe(10);
    expect(response.usage!.completionTokens).toBe(7);
    expect(response.usage!.totalTokens).toBe(17);
  });
});

// ── Block 3: CopilotAdapter proxy fallback + tool calling ─────────────────────

describe('CopilotAdapter integration (proxy fallback + tool calling)', () => {
  let port: number;
  const mockServer = createMockCopilotServer('tool_calls');

  beforeAll(async () => {
    port = await mockServer.start();
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  it('validates credentials successfully via proxy backend', async () => {
    const { CopilotAdapter } = await import('./copilot.js');
    const adapter = new CopilotAdapter({ baseUrl: `http://127.0.0.1:${port}` });
    await expect(adapter.validateCredentials()).resolves.toBeUndefined();
  });

  it('reports supportsTools as true after proxy backend init', async () => {
    const { CopilotAdapter } = await import('./copilot.js');
    const adapter = new CopilotAdapter({ baseUrl: `http://127.0.0.1:${port}` });
    await adapter.validateCredentials();
    expect(adapter.info.supportsTools).toBe(true);
  });

  it('returns parsed tool calls via chatWithTools through proxy backend', async () => {
    const { CopilotAdapter } = await import('./copilot.js');
    const adapter = new CopilotAdapter({ baseUrl: `http://127.0.0.1:${port}` });

    const tools: ToolDefinition[] = [
      {
        name: 'list_dir',
        description: 'List files in a directory',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to list' },
          },
          required: ['path'],
        },
      },
    ];

    const response = await adapter.chatWithTools(
      [{ role: 'user', content: 'List the current directory' }],
      tools
    );

    expect(response.toolCalls).toBeDefined();
    expect(response.toolCalls).toHaveLength(1);

    const toolCall = response.toolCalls![0]!;
    expect(toolCall.name).toBe('list_dir');
    expect(toolCall.id).toBe('call_abc123');
    expect(toolCall.arguments).toEqual({ path: '.' });

    expect(response.content).toBeNull();
  });
});

// ── Block 4: blockIfNoToolSupport with lazy-init CopilotAdapter ───────────────

describe('blockIfNoToolSupport with lazy-init CopilotAdapter', () => {
  let port: number;
  const mockServer = createMockCopilotServer('tool_calls');

  beforeAll(async () => {
    port = await mockServer.start();
  });

  afterAll(async () => {
    await mockServer.stop();
  });

  it('does not block the CopilotAdapter for the "run" command', async () => {
    const { CopilotAdapter } = await import('./copilot.js');
    const { blockIfNoToolSupport } = await import('./factory.js');
    const adapter = new CopilotAdapter({ baseUrl: `http://127.0.0.1:${port}` });
    await expect(blockIfNoToolSupport(adapter, 'run')).resolves.toBeUndefined();
  });

  it('does not block the CopilotAdapter for the "go" command', async () => {
    const { CopilotAdapter } = await import('./copilot.js');
    const { blockIfNoToolSupport } = await import('./factory.js');
    const adapter = new CopilotAdapter({ baseUrl: `http://127.0.0.1:${port}` });
    await expect(blockIfNoToolSupport(adapter, 'go')).resolves.toBeUndefined();
  });
});
