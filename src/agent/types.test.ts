import { describe, it, expect } from 'vitest';
import { validateDAG, topologicalSort } from './types.js';

describe('validateDAG', () => {
  it('returns null for valid DAG', () => {
    const graph = new Map([['a', []], ['b', ['a']], ['c', ['b']]]);
    expect(validateDAG(graph)).toBeNull();
  });

  it('returns cycle path for cyclic graph', () => {
    const graph = new Map([['a', ['c']], ['b', ['a']], ['c', ['b']]]);
    expect(validateDAG(graph)).not.toBeNull();
  });

  it('handles empty graph', () => {
    expect(validateDAG(new Map())).toBeNull();
  });

  it('handles self-loop', () => {
    const graph = new Map([['a', ['a']]]);
    expect(validateDAG(graph)).not.toBeNull();
  });
});

describe('topologicalSort', () => {
  it('sorts linear chain', () => {
    const graph = new Map([['a', []], ['b', ['a']], ['c', ['b']]]);
    const sorted = topologicalSort(graph);
    expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('b'));
    expect(sorted.indexOf('b')).toBeLessThan(sorted.indexOf('c'));
  });

  it('sorts diamond dependency', () => {
    const graph = new Map([['a', []], ['b', ['a']], ['c', ['a']], ['d', ['b', 'c']]]);
    const sorted = topologicalSort(graph);
    expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('b'));
    expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('c'));
    expect(sorted.indexOf('b')).toBeLessThan(sorted.indexOf('d'));
    expect(sorted.indexOf('c')).toBeLessThan(sorted.indexOf('d'));
  });

  it('throws on cycle', () => {
    const graph = new Map([['a', ['b']], ['b', ['a']]]);
    expect(() => topologicalSort(graph)).toThrow('Cycle detected');
  });
});
