import { describe, it, expect } from 'vitest';
import { IntelGraph } from './graph.js';

describe('IntelGraph', () => {
  function makeGraph(): IntelGraph {
    const g = new IntelGraph();
    g.addNode({ id: 'file:src/index.ts', type: 'file', name: 'index.ts', metadata: {} });
    g.addNode({ id: 'file:src/app.ts', type: 'file', name: 'app.ts', metadata: {} });
    g.addNode({ id: 'function:handleRequest', type: 'function', name: 'handleRequest', metadata: {} });
    g.addEdge({ source: 'file:src/index.ts', target: 'file:src/app.ts', type: 'imports' });
    g.addEdge({ source: 'file:src/app.ts', target: 'function:handleRequest', type: 'contains' });
    return g;
  }

  it('adds and retrieves nodes', () => {
    const g = makeGraph();
    expect(g.nodeCount).toBe(3);
    expect(g.getNode('file:src/index.ts')?.name).toBe('index.ts');
  });

  it('adds and retrieves edges', () => {
    const g = makeGraph();
    expect(g.edgeCount).toBe(2);
  });

  it('returns null for missing node', () => {
    const g = new IntelGraph();
    expect(g.getNode('nonexistent')).toBeNull();
  });

  it('finds neighbors (outgoing)', () => {
    const g = makeGraph();
    const neighbors = g.getNeighbors('file:src/index.ts', 'outgoing');
    expect(neighbors.map(n => n.id)).toEqual(['file:src/app.ts']);
  });

  it('finds neighbors (incoming)', () => {
    const g = makeGraph();
    const neighbors = g.getNeighbors('file:src/app.ts', 'incoming');
    expect(neighbors.map(n => n.id)).toEqual(['file:src/index.ts']);
  });

  it('filters nodes by type', () => {
    const g = makeGraph();
    const files = g.filterByType('file');
    expect(files).toHaveLength(2);
  });

  it('traverses paths between nodes (BFS shortest path)', () => {
    const g = makeGraph();
    const path = g.findPath('file:src/index.ts', 'function:handleRequest');
    expect(path).not.toBeNull();
    expect(path!.map(n => n.id)).toEqual([
      'file:src/index.ts', 'file:src/app.ts', 'function:handleRequest'
    ]);
  });

  it('returns null for no path', () => {
    const g = makeGraph();
    g.addNode({ id: 'file:isolated.ts', type: 'file', name: 'isolated', metadata: {} });
    expect(g.findPath('file:src/index.ts', 'file:isolated.ts')).toBeNull();
  });

  it('finds impact subgraph (all reachable via incoming edges)', () => {
    const g = makeGraph();
    const impact = g.getImpactSubgraph('function:handleRequest');
    expect(impact.map(n => n.id)).toContain('file:src/app.ts');
  });

  it('serializes and deserializes', () => {
    const g = makeGraph();
    const serialized = g.serialize('/tmp/test');
    const g2 = IntelGraph.deserialize(serialized);
    expect(g2.nodeCount).toBe(3);
    expect(g2.edgeCount).toBe(2);
    expect(g2.getNode('file:src/index.ts')?.name).toBe('index.ts');
  });

  it('keyword search matches node names', () => {
    const g = makeGraph();
    const results = g.search('handle');
    expect(results.map(n => n.id)).toContain('function:handleRequest');
  });

  it('computes stats', () => {
    const g = makeGraph();
    const stats = g.getStats();
    expect(stats.nodeCount).toBe(3);
    expect(stats.edgeCount).toBe(2);
  });

  it('removes a node and its edges', () => {
    const g = makeGraph();
    g.removeNode('file:src/app.ts');
    expect(g.nodeCount).toBe(2);
    expect(g.edgeCount).toBe(0);
  });

  it('estimates tokens for dry-run', () => {
    const g = makeGraph();
    expect(g.estimateTokens('shallow')).toBe(3 * 200);
    expect(g.estimateTokens('deep')).toBe(3 * 600);
    expect(g.estimateTokens('none')).toBe(0);
  });
});
