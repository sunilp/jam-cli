// src/intel/query.test.ts

import { describe, it, expect } from 'vitest';
import { query } from './query.js';
import { IntelGraph } from './graph.js';
import type { ProviderAdapter, ChatWithToolsResponse } from '../providers/base.js';
import type { SemanticMetadata } from './types.js';

// ── Test graph ────────────────────────────────────────────────────────────────

function makeGraph(): IntelGraph {
  const g = new IntelGraph();
  g.addNode({ id: 'file:src/auth.ts', type: 'file', name: 'auth.ts', filePath: 'src/auth.ts', metadata: {} });
  g.addNode({ id: 'file:src/user.ts', type: 'function', name: 'user.ts', filePath: 'src/user.ts', metadata: {} });
  g.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts', filePath: 'src/index.ts', metadata: {} });
  g.addNode({ id: 'table:users', type: 'table', name: 'users', metadata: {} });

  g.addEdge({ source: 'file:src/auth.ts', target: 'file:src/user.ts', type: 'imports' });
  g.addEdge({ source: 'file:src/index.ts', target: 'file:src/auth.ts', type: 'imports' });
  g.addEdge({ source: 'file:src/user.ts', target: 'table:users', type: 'reads' });

  return g;
}

const emptyEnrichment: SemanticMetadata[] = [];

// ── Offline mode ──────────────────────────────────────────────────────────────

describe('offline keyword search', () => {
  it('matches node names', async () => {
    const graph = makeGraph();
    const result = await query('auth', graph, emptyEnrichment, null, {});

    expect(result.nodes.map(n => n.id)).toContain('file:src/auth.ts');
  });

  it('returns empty for no matches', async () => {
    const graph = makeGraph();
    const result = await query('zzz_nonexistent_zzz', graph, emptyEnrichment, null, {});

    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('filters results by type when type option provided', async () => {
    const graph = makeGraph();
    // "ts" matches both file nodes and function node, but filter to 'table' should give 0
    const result = await query('ts', graph, emptyEnrichment, null, { type: 'table' });

    expect(result.nodes.every(n => n.type === 'table')).toBe(true);
  });

  it('type filter returns nodes of that type that also match keyword', async () => {
    const graph = makeGraph();
    // search for "auth" with file type
    const result = await query('auth', graph, emptyEnrichment, null, { type: 'file' });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.id).toBe('file:src/auth.ts');
  });

  it('includes mermaid output when mermaid option is set', async () => {
    const graph = makeGraph();
    const result = await query('auth', graph, emptyEnrichment, null, { mermaid: true });

    expect(result.mermaid).toBeDefined();
    expect(result.mermaid).toContain('graph LR');
  });

  it('does not include mermaid when option not set', async () => {
    const graph = makeGraph();
    const result = await query('auth', graph, emptyEnrichment, null, {});

    expect(result.mermaid).toBeUndefined();
  });
});

// ── Fallback behavior ─────────────────────────────────────────────────────────

describe('falls back to offline mode', () => {
  it('when provider is null', async () => {
    const graph = makeGraph();
    const result = await query('auth', graph, emptyEnrichment, null, {});

    expect(result.nodes.map(n => n.id)).toContain('file:src/auth.ts');
  });

  it('when chatWithTools is unavailable on provider', async () => {
    const providerWithoutTools: ProviderAdapter = {
      info: { name: 'mock', supportsStreaming: true },
      validateCredentials: async () => {},
      listModels: async () => [],
      streamCompletion: async function* () {
        yield { delta: '', done: true };
      },
      // No chatWithTools
    } as unknown as ProviderAdapter;

    const graph = makeGraph();
    const result = await query('auth', graph, emptyEnrichment, providerWithoutTools, {});

    expect(result.nodes.map(n => n.id)).toContain('file:src/auth.ts');
  });

  it('when noAi option is true', async () => {
    const providerWithTools: ProviderAdapter = {
      info: { name: 'mock', supportsStreaming: true },
      validateCredentials: async () => {},
      listModels: async () => [],
      streamCompletion: async function* () { yield { delta: '', done: true }; },
      chatWithTools: async () => ({ content: 'AI response', toolCalls: [] }),
    } as unknown as ProviderAdapter;

    const graph = makeGraph();
    const result = await query('auth', graph, emptyEnrichment, providerWithTools, { noAi: true });

    // Should have used offline search — no explanation field
    expect(result.explanation).toBeUndefined();
    expect(result.nodes.map(n => n.id)).toContain('file:src/auth.ts');
  });

  it('falls back to offline when chatWithTools throws', async () => {
    const failingProvider: ProviderAdapter = {
      info: { name: 'mock', supportsStreaming: true },
      validateCredentials: async () => {},
      listModels: async () => [],
      streamCompletion: async function* () { yield { delta: '', done: true }; },
      chatWithTools: async () => { throw new Error('API error'); },
    } as unknown as ProviderAdapter;

    const graph = makeGraph();
    const result = await query('auth', graph, emptyEnrichment, failingProvider, {});

    // Should fall back to offline and still find auth
    expect(result.nodes.map(n => n.id)).toContain('file:src/auth.ts');
  });
});

// ── NL mode with tool calling ─────────────────────────────────────────────────

describe('NL query with mocked chatWithTools', () => {
  it('executes findNode tool call and returns matching nodes', async () => {
    const graph = makeGraph();

    const mockChatWithToolsResponse: ChatWithToolsResponse = {
      content: 'Found the auth module.',
      toolCalls: [
        { id: '1', name: 'findNode', arguments: { keyword: 'auth' } },
      ],
    };

    const aiProvider: ProviderAdapter = {
      info: { name: 'mock', supportsStreaming: true },
      validateCredentials: async () => {},
      listModels: async () => [],
      streamCompletion: async function* () { yield { delta: '', done: true }; },
      chatWithTools: async () => mockChatWithToolsResponse,
    } as unknown as ProviderAdapter;

    const result = await query('find auth module', graph, emptyEnrichment, aiProvider, {});

    expect(result.nodes.map(n => n.id)).toContain('file:src/auth.ts');
    expect(result.explanation).toBe('Found the auth module.');
  });

  it('executes filterByType tool call', async () => {
    const graph = makeGraph();

    const mockResponse: ChatWithToolsResponse = {
      content: 'All tables in the graph.',
      toolCalls: [
        { id: '2', name: 'filterByType', arguments: { type: 'table' } },
      ],
    };

    const aiProvider: ProviderAdapter = {
      info: { name: 'mock', supportsStreaming: true },
      validateCredentials: async () => {},
      listModels: async () => [],
      streamCompletion: async function* () { yield { delta: '', done: true }; },
      chatWithTools: async () => mockResponse,
    } as unknown as ProviderAdapter;

    const result = await query('list all tables', graph, emptyEnrichment, aiProvider, {});

    expect(result.nodes.every(n => n.type === 'table')).toBe(true);
    expect(result.nodes.map(n => n.id)).toContain('table:users');
  });

  it('executes getNeighbors tool call', async () => {
    const graph = makeGraph();

    const mockResponse: ChatWithToolsResponse = {
      content: 'Neighbors of auth.',
      toolCalls: [
        { id: '3', name: 'getNeighbors', arguments: { nodeId: 'file:src/auth.ts', direction: 'outgoing' } },
      ],
    };

    const aiProvider: ProviderAdapter = {
      info: { name: 'mock', supportsStreaming: true },
      validateCredentials: async () => {},
      listModels: async () => [],
      streamCompletion: async function* () { yield { delta: '', done: true }; },
      chatWithTools: async () => mockResponse,
    } as unknown as ProviderAdapter;

    const result = await query('what does auth depend on', graph, emptyEnrichment, aiProvider, {});

    // auth.ts → user.ts (outgoing)
    expect(result.nodes.map(n => n.id)).toContain('file:src/user.ts');
  });

  it('executes getImpactSubgraph tool call', async () => {
    const graph = makeGraph();

    const mockResponse: ChatWithToolsResponse = {
      content: 'Impact of changing auth.',
      toolCalls: [
        { id: '4', name: 'getImpactSubgraph', arguments: { nodeId: 'file:src/auth.ts' } },
      ],
    };

    const aiProvider: ProviderAdapter = {
      info: { name: 'mock', supportsStreaming: true },
      validateCredentials: async () => {},
      listModels: async () => [],
      streamCompletion: async function* () { yield { delta: '', done: true }; },
      chatWithTools: async () => mockResponse,
    } as unknown as ProviderAdapter;

    const result = await query('impact of changing auth', graph, emptyEnrichment, aiProvider, {});

    // index.ts imports auth.ts, so it should be in the impact subgraph
    expect(result.nodes.map(n => n.id)).toContain('file:src/index.ts');
  });

  it('includes mermaid when option set in NL mode', async () => {
    const graph = makeGraph();

    const mockResponse: ChatWithToolsResponse = {
      content: 'Found nodes.',
      toolCalls: [
        { id: '5', name: 'findNode', arguments: { keyword: 'auth' } },
      ],
    };

    const aiProvider: ProviderAdapter = {
      info: { name: 'mock', supportsStreaming: true },
      validateCredentials: async () => {},
      listModels: async () => [],
      streamCompletion: async function* () { yield { delta: '', done: true }; },
      chatWithTools: async () => mockResponse,
    } as unknown as ProviderAdapter;

    const result = await query('auth', graph, emptyEnrichment, aiProvider, { mermaid: true });

    expect(result.mermaid).toBeDefined();
    expect(result.mermaid).toContain('graph LR');
  });

  it('falls back to offline when no tool calls returned', async () => {
    const graph = makeGraph();

    // Provider returns no tool calls
    const mockResponse: ChatWithToolsResponse = {
      content: 'I cannot help with that.',
      toolCalls: [],
    };

    const aiProvider: ProviderAdapter = {
      info: { name: 'mock', supportsStreaming: true },
      validateCredentials: async () => {},
      listModels: async () => [],
      streamCompletion: async function* () { yield { delta: '', done: true }; },
      chatWithTools: async () => mockResponse,
    } as unknown as ProviderAdapter;

    const result = await query('auth', graph, emptyEnrichment, aiProvider, {});

    // Should fall back to offline keyword search
    expect(result.nodes.map(n => n.id)).toContain('file:src/auth.ts');
  });
});
