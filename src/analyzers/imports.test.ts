import { describe, it, expect } from 'vitest';
import { extractImports, findCycles } from './imports.js';
import type { Graph } from './types.js';

describe('extractImports', () => {
  it('extracts ESM import from', () => {
    const code = `import { foo } from './foo.js';`;
    expect(extractImports(code)).toEqual(['./foo.js']);
  });

  it('extracts ESM export from', () => {
    const code = `export { bar } from './bar.js';`;
    expect(extractImports(code)).toEqual(['./bar.js']);
  });

  it('extracts require()', () => {
    const code = `const x = require('./util');`;
    expect(extractImports(code)).toEqual(['./util']);
  });

  it('extracts dynamic import()', () => {
    const code = `const mod = import('./dynamic.js');`;
    expect(extractImports(code)).toEqual(['./dynamic.js']);
  });

  it('ignores non-relative imports', () => {
    const code = `import chalk from 'chalk';\nimport { join } from 'node:path';`;
    expect(extractImports(code)).toEqual([]);
  });

  it('extracts multiple imports', () => {
    const code = `import { a } from './a.js';\nimport { b } from './b.js';\nconst c = require('./c');`;
    expect(extractImports(code)).toEqual(['./a.js', './b.js', './c']);
  });

  it('returns empty for no imports', () => {
    expect(extractImports('const x = 42;')).toEqual([]);
  });
});

describe('findCycles', () => {
  it('finds no cycles in acyclic graph', () => {
    const graph: Graph = new Map([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set()],
    ]);
    expect(findCycles(graph)).toEqual([]);
  });

  it('finds a simple cycle', () => {
    const graph: Graph = new Map([
      ['a', new Set(['b'])],
      ['b', new Set(['a'])],
    ]);
    const cycles = findCycles(graph);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toContain('a');
    expect(cycles[0]).toContain('b');
  });

  it('finds a self-loop', () => {
    const graph: Graph = new Map([
      ['a', new Set(['a'])],
    ]);
    const cycles = findCycles(graph);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toEqual(['a']);
  });

  it('finds multiple independent cycles', () => {
    const graph: Graph = new Map([
      ['a', new Set(['b'])],
      ['b', new Set(['a'])],
      ['c', new Set(['d'])],
      ['d', new Set(['c'])],
    ]);
    const cycles = findCycles(graph);
    expect(cycles).toHaveLength(2);
  });

  it('handles empty graph', () => {
    const graph: Graph = new Map();
    expect(findCycles(graph)).toEqual([]);
  });
});
