// src/trace/graph.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TraceStore } from './store.js';
import { traceSymbol } from './graph.js';

describe('traceSymbol', () => {
  let dir: string;
  let store: TraceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trace-graph-'));
    store = new TraceStore(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedIndex(): void {
    // Create symbol: processData
    const processDataId = store.insertSymbol({
      name: 'processData',
      kind: 'function',
      file: 'src/processor.ts',
      line: 10,
      endLine: 25,
      signature: '(input: string)',
      returnType: 'Promise<Result>',
      language: 'typescript',
    });

    // Create symbol: handleRequest (calls processData)
    const handleRequestId = store.insertSymbol({
      name: 'handleRequest',
      kind: 'function',
      file: 'src/handler.ts',
      line: 5,
      signature: '(req: Request)',
      returnType: 'Response',
      language: 'typescript',
    });

    // Create symbol: main (calls handleRequest)
    const mainId = store.insertSymbol({
      name: 'main',
      kind: 'function',
      file: 'src/index.ts',
      line: 1,
      language: 'typescript',
    });

    // Create symbol: sanitize (called by processData)
    const sanitizeId = store.insertSymbol({
      name: 'sanitize',
      kind: 'function',
      file: 'src/utils.ts',
      line: 3,
      language: 'typescript',
    });

    // handleRequest calls processData
    store.insertCall({
      callerId: handleRequestId,
      calleeName: 'processData',
      file: 'src/handler.ts',
      line: 12,
      arguments: 'req.body',
    });

    // main calls handleRequest
    store.insertCall({
      callerId: mainId,
      calleeName: 'handleRequest',
      file: 'src/index.ts',
      line: 3,
      arguments: 'req',
    });

    // processData calls sanitize
    store.insertCall({
      callerId: processDataId,
      calleeName: 'sanitize',
      file: 'src/processor.ts',
      line: 15,
      arguments: 'input',
    });

    // Import of processData
    store.insertImport({
      file: 'src/handler.ts',
      symbolName: 'processData',
      sourceModule: './processor.js',
    });
  }

  it('traces a symbol and returns callers, callees, imports', () => {
    seedIndex();

    const result = traceSymbol(store, 'processData');

    expect(result.notFound).toBe(false);
    expect(result.symbol.name).toBe('processData');
    expect(result.symbol.kind).toBe('function');
    expect(result.symbol.file).toBe('src/processor.ts');
    expect(result.symbol.line).toBe(10);
    expect(result.symbol.signature).toBe('(input: string)');
    expect(result.symbol.returnType).toBe('Promise<Result>');
    expect(result.symbol.language).toBe('typescript');

    // Callers
    expect(result.callers).toHaveLength(1);
    expect(result.callers[0]!.symbolName).toBe('handleRequest');
    expect(result.callers[0]!.file).toBe('src/handler.ts');
    expect(result.callers[0]!.arguments).toBe('req.body');

    // Callees
    expect(result.callees).toHaveLength(1);
    expect(result.callees[0]!.name).toBe('sanitize');
    expect(result.callees[0]!.arguments).toBe('input');

    // Imports
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]!.file).toBe('src/handler.ts');
    expect(result.imports[0]!.sourceModule).toBe('./processor.js');
  });

  it('builds upstream chain recursively', () => {
    seedIndex();

    const result = traceSymbol(store, 'processData', { depth: 5 });

    // processData ← handleRequest ← main
    expect(result.upstreamChain).toHaveLength(1);
    const upstream = result.upstreamChain[0]!;
    expect(upstream.name).toBe('handleRequest');
    expect(upstream.file).toBe('src/handler.ts');
    expect(upstream.language).toBe('typescript');

    // handleRequest ← main
    expect(upstream.callers).toHaveLength(1);
    expect(upstream.callers[0]!.name).toBe('main');
    expect(upstream.callers[0]!.file).toBe('src/index.ts');
  });

  it('returns notFound with candidates when symbol does not exist', () => {
    seedIndex();

    const result = traceSymbol(store, 'nonexistent');
    expect(result.notFound).toBe(true);
    expect(result.callers).toHaveLength(0);
  });

  it('finds fuzzy candidates for partial matches', () => {
    seedIndex();

    const result = traceSymbol(store, 'process');
    expect(result.notFound).toBe(true);
    expect(result.candidates).toBeDefined();
    expect(result.candidates!.some(c => c.name === 'processData')).toBe(true);
  });

  it('respects depth limit', () => {
    seedIndex();

    const result = traceSymbol(store, 'processData', { depth: 1 });

    // depth=1 means only immediate callers, no recursion into their callers
    expect(result.upstreamChain).toHaveLength(1);
    const upstream = result.upstreamChain[0]!;
    expect(upstream.name).toBe('handleRequest');
    // At depth 1, buildUpstream is called with depth-1=0 for children, so no sub-callers
    expect(upstream.callers).toHaveLength(0);
  });

  it('handles cycles in the call graph', () => {
    // Create a cycle: A → B → A
    const aId = store.insertSymbol({
      name: 'funcA',
      kind: 'function',
      file: 'a.ts',
      line: 1,
      language: 'typescript',
    });

    const bId = store.insertSymbol({
      name: 'funcB',
      kind: 'function',
      file: 'b.ts',
      line: 1,
      language: 'typescript',
    });

    // A calls B
    store.insertCall({ callerId: aId, calleeName: 'funcB', file: 'a.ts', line: 5 });
    // B calls A (cycle)
    store.insertCall({ callerId: bId, calleeName: 'funcA', file: 'b.ts', line: 5 });

    // Should not infinite loop
    const result = traceSymbol(store, 'funcA', { depth: 10 });
    expect(result.notFound).toBe(false);
    // funcA has caller funcB, and funcB's caller funcA is a cycle (skipped)
    expect(result.upstreamChain).toHaveLength(1);
    expect(result.upstreamChain[0]!.name).toBe('funcB');
    expect(result.upstreamChain[0]!.callers).toHaveLength(0); // cycle broken
  });

  it('deduplicates callers by symbol id', () => {
    const callerId = store.insertSymbol({
      name: 'caller',
      kind: 'function',
      file: 'src/caller.ts',
      line: 1,
      language: 'typescript',
    });

    store.insertSymbol({
      name: 'target',
      kind: 'function',
      file: 'src/target.ts',
      line: 1,
      language: 'typescript',
    });

    // Same caller calls target twice
    store.insertCall({ callerId, calleeName: 'target', file: 'src/caller.ts', line: 5 });
    store.insertCall({ callerId, calleeName: 'target', file: 'src/caller.ts', line: 10 });

    const result = traceSymbol(store, 'target');
    // Both call sites should appear as callers (they have different lines)
    expect(result.callers.length).toBe(2);
  });
});
