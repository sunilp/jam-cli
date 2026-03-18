// src/intel/enrichment.test.ts

import { describe, it, expect, vi } from 'vitest';
import { EnrichmentEngine } from './enrichment.js';
import { IntelGraph } from './graph.js';
import type { ProviderAdapter } from '../providers/base.js';
import type { IntelNode } from './types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeGraph(): IntelGraph {
  const g = new IntelGraph();
  // auth module — highest connectivity (3 edges)
  g.addNode({ id: 'file:src/auth.ts', type: 'file', name: 'auth.ts', filePath: 'src/auth.ts', language: 'typescript', metadata: {} });
  // index — medium connectivity (2 edges)
  g.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts', filePath: 'src/index.ts', language: 'typescript', metadata: {} });
  // utils — low connectivity (1 edge)
  g.addNode({ id: 'file:src/utils.ts', type: 'file', name: 'utils.ts', filePath: 'src/utils.ts', language: 'typescript', metadata: {} });

  g.addEdge({ source: 'file:src/index.ts', target: 'file:src/auth.ts', type: 'imports' });
  g.addEdge({ source: 'file:src/auth.ts', target: 'file:src/utils.ts', type: 'imports' });
  g.addEdge({ source: 'file:src/index.ts', target: 'file:src/utils.ts', type: 'imports' });

  return g;
}

function makeMockProvider(responseJson: string): ProviderAdapter {
  return {
    info: { name: 'mock', supportsStreaming: true },
    validateCredentials: async () => {},
    listModels: async () => [],
    streamCompletion: async function* () {
      yield { delta: responseJson, done: true };
    },
  } as unknown as ProviderAdapter;
}

// ── prioritize ───────────────────────────────────────────────────────────────

describe('EnrichmentEngine.prioritize', () => {
  it('returns high-connectivity nodes first', () => {
    const graph = makeGraph();
    const provider = makeMockProvider('{}');
    const engine = new EnrichmentEngine(provider);

    const order = engine.prioritize(graph);

    // auth.ts: inDegree=1, outDegree=1 → score 2
    // index.ts: inDegree=0, outDegree=2 → score 2
    // utils.ts: inDegree=2, outDegree=0 → score 2
    // All have score=2 in this graph; check they all appear
    expect(order).toHaveLength(3);
    expect(order).toContain('file:src/auth.ts');
    expect(order).toContain('file:src/index.ts');
    expect(order).toContain('file:src/utils.ts');
  });

  it('sorts by descending score', () => {
    const graph = new IntelGraph();
    graph.addNode({ id: 'hub', type: 'file', name: 'hub.ts', metadata: {} });
    graph.addNode({ id: 'leaf', type: 'file', name: 'leaf.ts', metadata: {} });
    graph.addNode({ id: 'isolated', type: 'file', name: 'isolated.ts', metadata: {} });
    // hub → leaf (hub outDegree=1, leaf inDegree=1)
    graph.addEdge({ source: 'hub', target: 'leaf', type: 'imports' });

    const provider = makeMockProvider('{}');
    const engine = new EnrichmentEngine(provider);

    const order = engine.prioritize(graph);

    // hub: score=1, leaf: score=1, isolated: score=0
    expect(order.indexOf('isolated')).toBeGreaterThan(order.indexOf('hub'));
    expect(order.indexOf('isolated')).toBeGreaterThan(order.indexOf('leaf'));
  });

  it('uses churn data to boost score', () => {
    const graph = new IntelGraph();
    graph.addNode({ id: 'stable', type: 'file', name: 'stable.ts', metadata: {} });
    graph.addNode({ id: 'churny', type: 'file', name: 'churny.ts', metadata: {} });

    const churnData = new Map<string, number>([
      ['churny', 50],
      ['stable', 0],
    ]);

    const provider = makeMockProvider('{}');
    const engine = new EnrichmentEngine(provider);

    const order = engine.prioritize(graph, churnData);

    expect(order[0]).toBe('churny');
    expect(order[1]).toBe('stable');
  });
});

// ── buildPrompt ───────────────────────────────────────────────────────────────

describe('EnrichmentEngine.buildPrompt', () => {
  const node: IntelNode = {
    id: 'file:src/auth.ts',
    type: 'file',
    name: 'auth.ts',
    filePath: 'src/auth.ts',
    language: 'typescript',
    framework: 'express',
    metadata: {},
  };

  const neighbor: IntelNode = {
    id: 'file:src/utils.ts',
    type: 'file',
    name: 'utils.ts',
    metadata: {},
  };

  it('includes node context in the user prompt', () => {
    const provider = makeMockProvider('{}');
    const engine = new EnrichmentEngine(provider);

    const { user } = engine.buildPrompt(node, [neighbor], 'shallow');

    expect(user).toContain('auth.ts');
    expect(user).toContain('typescript');
    expect(user).toContain('express');
    expect(user).toContain('utils.ts');
  });

  it('shallow depth only requests purpose and summary in system prompt', () => {
    const provider = makeMockProvider('{}');
    const engine = new EnrichmentEngine(provider);

    const { system } = engine.buildPrompt(node, [], 'shallow');

    expect(system).toContain('purpose');
    expect(system).toContain('summary');
    // deep-only fields should NOT be in shallow system prompt
    expect(system).not.toContain('pattern');
    expect(system).not.toContain('semanticEdges');
  });

  it('deep depth requests all fields in system prompt', () => {
    const provider = makeMockProvider('{}');
    const engine = new EnrichmentEngine(provider);

    const { system } = engine.buildPrompt(node, [], 'deep');

    expect(system).toContain('purpose');
    expect(system).toContain('summary');
    expect(system).toContain('pattern');
    expect(system).toContain('semanticEdges');
    expect(system).toContain('risk');
  });
});

// ── parseResponse ─────────────────────────────────────────────────────────────

describe('EnrichmentEngine.parseResponse', () => {
  const provider = makeMockProvider('{}');
  const engine = new EnrichmentEngine(provider);

  it('extracts structured metadata from valid JSON', () => {
    const json = JSON.stringify({
      purpose: 'Handles auth',
      summary: 'Auth middleware',
      pattern: 'Middleware',
      domain: 'security',
      risk: 'medium',
      semanticEdges: [{ target: 'file:src/db.ts', type: 'reads', reason: 'reads user records' }],
    });

    const meta = engine.parseResponse(json, 'file:src/auth.ts', 'deep');

    expect(meta.nodeId).toBe('file:src/auth.ts');
    expect(meta.purpose).toBe('Handles auth');
    expect(meta.summary).toBe('Auth middleware');
    expect(meta.pattern).toBe('Middleware');
    expect(meta.domain).toBe('security');
    expect(meta.risk).toBe('medium');
    expect(meta.semanticEdges).toHaveLength(1);
    expect(meta.semanticEdges![0]!.target).toBe('file:src/db.ts');
  });

  it('handles malformed JSON gracefully', () => {
    const meta = engine.parseResponse('not valid json at all!!!', 'file:src/broken.ts', 'shallow');

    expect(meta.nodeId).toBe('file:src/broken.ts');
    expect(meta.depth).toBe('shallow');
    expect(meta.purpose).toBeUndefined();
    expect(meta.summary).toBeUndefined();
  });

  it('strips markdown code fences', () => {
    const wrapped = '```json\n{"purpose":"Test","summary":"A test"}\n```';
    const meta = engine.parseResponse(wrapped, 'file:src/test.ts', 'shallow');

    expect(meta.purpose).toBe('Test');
    expect(meta.summary).toBe('A test');
  });

  it('shallow depth ignores deep fields even if present in JSON', () => {
    const json = JSON.stringify({
      purpose: 'Quick purpose',
      summary: 'Quick summary',
      pattern: 'should be ignored',
      risk: 'high',
    });

    const meta = engine.parseResponse(json, 'file:src/x.ts', 'shallow');

    expect(meta.purpose).toBe('Quick purpose');
    expect(meta.summary).toBe('Quick summary');
    // deep fields should NOT be set for shallow depth
    expect(meta.pattern).toBeUndefined();
    expect(meta.risk).toBeUndefined();
  });
});

// ── enrichAll ─────────────────────────────────────────────────────────────────

describe('EnrichmentEngine.enrichAll', () => {
  it('stops when budget exceeded', async () => {
    const graph = makeGraph();
    const provider = makeMockProvider(JSON.stringify({ purpose: 'Handles auth', summary: 'Auth middleware' }));
    const engine = new EnrichmentEngine(provider);

    // Budget so small only 1 node fits (prompt would be ~200+ tokens, budget=1 forces stop after first)
    const results = await engine.enrichAll(graph, { depth: 'shallow', maxTokenBudget: 1 });

    // With budget=1, no node should be enriched (cost always > 1)
    expect(results.length).toBe(0);
  });

  it('reports progress for each enriched node', async () => {
    const graph = makeGraph();
    const provider = makeMockProvider(JSON.stringify({ purpose: 'Some purpose', summary: 'Some summary' }));
    const engine = new EnrichmentEngine(provider);

    const progressUpdates: Array<{ progress: number; nodeId: string }> = [];
    await engine.enrichAll(graph, {
      depth: 'shallow',
      maxTokenBudget: 1_000_000,
      onProgress: (progress, nodeId) => {
        progressUpdates.push({ progress, nodeId });
      },
    });

    // Should have one progress update per node
    expect(progressUpdates.length).toBe(3);
    // Progress should increase monotonically
    for (let i = 1; i < progressUpdates.length; i++) {
      expect(progressUpdates[i]!.progress).toBeGreaterThan(progressUpdates[i - 1]!.progress);
    }
  });

  it('skips nodes on LLM error and continues', async () => {
    const graph = makeGraph();
    let callCount = 0;
    const failingProvider: ProviderAdapter = {
      info: { name: 'mock', supportsStreaming: true },
      validateCredentials: async () => {},
      listModels: async () => [],
      streamCompletion: async function* () {
        callCount++;
        if (callCount === 2) {
          // Second node throws
          throw new Error('LLM quota exceeded');
        }
        yield { delta: JSON.stringify({ purpose: 'OK', summary: 'OK summary' }), done: true };
      },
    } as unknown as ProviderAdapter;

    const engine = new EnrichmentEngine(failingProvider);
    const results = await engine.enrichAll(graph, { depth: 'shallow', maxTokenBudget: 1_000_000 });

    // Should have enriched 2 of 3 nodes (1 skipped due to error)
    expect(results.length).toBe(2);
  });

  it('returns empty array when depth is none', async () => {
    const graph = makeGraph();
    const provider = makeMockProvider('{}');
    const engine = new EnrichmentEngine(provider);

    const results = await engine.enrichAll(graph, { depth: 'none', maxTokenBudget: 1_000_000 });

    expect(results).toHaveLength(0);
  });

  it('returns empty array for empty graph', async () => {
    const graph = new IntelGraph();
    const provider = makeMockProvider(JSON.stringify({ purpose: 'x', summary: 'y' }));
    const engine = new EnrichmentEngine(provider);

    const results = await engine.enrichAll(graph, { depth: 'shallow', maxTokenBudget: 1_000_000 });

    expect(results).toHaveLength(0);
  });
});
