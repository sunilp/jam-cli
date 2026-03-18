// src/intel/mermaid.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { IntelGraph } from './graph.js';
import type { IntelNode, IntelEdge } from './types.js';
import {
  generateArchitectureDiagram,
  generateDepsDiagram,
  generateFlowDiagram,
  generateImpactDiagram,
  generateFrameworkDiagram,
  formatQueryResultAsMermaid,
} from './mermaid.js';

function buildSampleGraph(): IntelGraph {
  const g = new IntelGraph();

  // Modules
  g.addNode({ id: 'file:src/index.ts', type: 'file', name: 'src/index.ts', filePath: 'src/index.ts', language: 'typescript', metadata: {} });
  g.addNode({ id: 'file:src/app.ts', type: 'file', name: 'src/app.ts', filePath: 'src/app.ts', language: 'typescript', metadata: {} });
  g.addNode({ id: 'file:lib/utils.ts', type: 'file', name: 'lib/utils.ts', filePath: 'lib/utils.ts', language: 'typescript', metadata: {} });

  // Service node
  g.addNode({ id: 'service:web', type: 'service', name: 'web', metadata: { framework: 'express' }, framework: 'express' });

  // Endpoint node
  g.addNode({ id: 'endpoint:GET /health', type: 'endpoint', name: 'GET /health', filePath: 'src/app.ts', framework: 'express', metadata: { method: 'GET', path: '/health' } });
  g.addNode({ id: 'endpoint:POST /users', type: 'endpoint', name: 'POST /users', filePath: 'src/app.ts', framework: 'express', metadata: { method: 'POST', path: '/users' } });

  // Table node
  g.addNode({ id: 'table:users', type: 'table', name: 'users', metadata: {} });

  // External node
  g.addNode({ id: 'external:node:18', type: 'external', name: 'node:18', metadata: {} });

  // Edges
  g.addEdge({ source: 'file:src/index.ts', target: 'file:src/app.ts', type: 'imports' });
  g.addEdge({ source: 'file:src/app.ts', target: 'file:lib/utils.ts', type: 'imports' });
  g.addEdge({ source: 'file:src/app.ts', target: 'endpoint:GET /health', type: 'contains' });
  g.addEdge({ source: 'file:src/app.ts', target: 'endpoint:POST /users', type: 'contains' });
  g.addEdge({ source: 'endpoint:POST /users', target: 'table:users', type: 'writes' });
  g.addEdge({ source: 'endpoint:GET /health', target: 'table:users', type: 'reads' });

  g.frameworks = ['express'];
  g.languages = ['typescript'];

  return g;
}

describe('generateArchitectureDiagram', () => {
  let graph: IntelGraph;
  beforeEach(() => { graph = buildSampleGraph(); });

  it('starts with graph TD', () => {
    const result = generateArchitectureDiagram(graph);
    expect(result).toMatch(/^graph TD/);
  });

  it('includes module subgraphs', () => {
    const result = generateArchitectureDiagram(graph);
    expect(result).toContain('subgraph');
    // src module should appear
    expect(result).toContain('src');
  });

  it('includes node names', () => {
    const result = generateArchitectureDiagram(graph);
    expect(result).toContain('src/index.ts');
    expect(result).toContain('src/app.ts');
  });

  it('includes edge type labels', () => {
    const result = generateArchitectureDiagram(graph);
    expect(result).toContain('imports');
  });
});

describe('generateDepsDiagram', () => {
  let graph: IntelGraph;
  beforeEach(() => { graph = buildSampleGraph(); });

  it('starts with graph LR', () => {
    const result = generateDepsDiagram(graph);
    expect(result).toMatch(/^graph LR/);
  });

  it('contains node names', () => {
    const result = generateDepsDiagram(graph);
    expect(result).toContain('src/index.ts');
  });

  it('accepts a focus node', () => {
    const result = generateDepsDiagram(graph, 'file:src/index.ts');
    expect(result).toMatch(/^graph LR/);
    // Should include the focal node
    expect(result).toContain('src/index.ts');
  });
});

describe('generateFlowDiagram', () => {
  let graph: IntelGraph;
  beforeEach(() => { graph = buildSampleGraph(); });

  it('starts with graph LR', () => {
    const result = generateFlowDiagram(graph);
    expect(result).toMatch(/^graph LR/);
  });

  it('includes data flow edge labels', () => {
    const result = generateFlowDiagram(graph);
    // Should show reads and/or writes
    const hasFlow = result.includes('reads') || result.includes('writes');
    expect(hasFlow).toBe(true);
  });

  it('shows table nodes involved in flow', () => {
    const result = generateFlowDiagram(graph);
    expect(result).toContain('users');
  });
});

describe('generateImpactDiagram', () => {
  let graph: IntelGraph;
  beforeEach(() => { graph = buildSampleGraph(); });

  it('starts with graph TD', () => {
    const result = generateImpactDiagram(graph, 'file:lib/utils.ts');
    expect(result).toMatch(/^graph TD/);
  });

  it('includes style directives for target node', () => {
    const result = generateImpactDiagram(graph, 'file:lib/utils.ts');
    expect(result).toContain('style');
    expect(result).toContain('fill:#f96');
  });

  it('handles non-existent node gracefully', () => {
    const result = generateImpactDiagram(graph, 'nonexistent:node');
    expect(result).toContain('not found');
  });
});

describe('generateFrameworkDiagram', () => {
  let graph: IntelGraph;
  beforeEach(() => { graph = buildSampleGraph(); });

  it('returns graph LR', () => {
    const result = generateFrameworkDiagram(graph, 'express');
    expect(result).toMatch(/^graph LR/);
  });

  it('only includes express framework nodes', () => {
    const result = generateFrameworkDiagram(graph, 'express');
    // Express endpoints should be present
    expect(result).toContain('GET /health');
  });
});

describe('Mermaid shapes', () => {
  it('endpoints use hexagon shape {{}}', () => {
    const g = new IntelGraph();
    g.addNode({ id: 'endpoint:GET /test', type: 'endpoint', name: 'GET /test', metadata: {} });
    const result = generateArchitectureDiagram(g);
    expect(result).toContain('{{');
    expect(result).toContain('}}');
  });

  it('tables use cylinder shape [()]', () => {
    const g = new IntelGraph();
    g.addNode({ id: 'table:orders', type: 'table', name: 'orders', metadata: {} });
    const result = generateArchitectureDiagram(g);
    expect(result).toContain('[(');
    expect(result).toContain(')]');
  });

  it('services use rounded shape ([])', () => {
    const g = new IntelGraph();
    g.addNode({ id: 'service:api', type: 'service', name: 'api', metadata: {} });
    const result = generateArchitectureDiagram(g);
    expect(result).toContain('(["api"])');
  });

  it('external nodes use flag shape >]', () => {
    const g = new IntelGraph();
    g.addNode({ id: 'external:postgres', type: 'external', name: 'postgres', metadata: {} });
    const result = generateArchitectureDiagram(g);
    expect(result).toContain('>"postgres"]');
  });
});

describe('formatQueryResultAsMermaid', () => {
  it('produces valid Mermaid starting with graph LR', () => {
    const nodes: IntelNode[] = [
      { id: 'file:a.ts', type: 'file', name: 'a.ts', metadata: {} },
      { id: 'file:b.ts', type: 'file', name: 'b.ts', metadata: {} },
    ];
    const edges: IntelEdge[] = [
      { source: 'file:a.ts', target: 'file:b.ts', type: 'imports' },
    ];
    const result = formatQueryResultAsMermaid(nodes, edges);
    expect(result).toMatch(/^graph LR/);
    expect(result).toContain('subgraph');
    expect(result).toContain('a.ts');
    expect(result).toContain('b.ts');
  });

  it('highlights nodes with blue style', () => {
    const nodes: IntelNode[] = [
      { id: 'function:myFn', type: 'function', name: 'myFn', metadata: {} },
    ];
    const result = formatQueryResultAsMermaid(nodes, []);
    expect(result).toContain('fill:#6af');
  });
});
