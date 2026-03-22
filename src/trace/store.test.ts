// src/trace/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TraceStore } from './store.js';

describe('TraceStore', () => {
  let dir: string;
  let store: TraceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trace-store-'));
    store = new TraceStore(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates database and tables on init', () => {
    // Should not throw
    expect(store.getSchemaVersion()).toBe(1);
  });

  it('inserts and queries symbols by name', () => {
    store.insertSymbol({
      name: 'processData',
      kind: 'function',
      file: 'src/processor.ts',
      line: 10,
      endLine: 25,
      signature: '(input: string)',
      returnType: 'Promise<Result>',
      bodyHash: 'abc123',
      language: 'typescript',
    });

    const symbols = store.findSymbolsByName('processData');
    expect(symbols).toHaveLength(1);
    expect(symbols[0]!.kind).toBe('function');
    expect(symbols[0]!.file).toBe('src/processor.ts');
  });

  it('inserts and queries calls by callee name', () => {
    const symbolId = store.insertSymbol({
      name: 'handler',
      kind: 'function',
      file: 'src/handler.ts',
      line: 5,
      language: 'typescript',
    });

    store.insertCall({
      callerId: symbolId,
      calleeName: 'processData',
      file: 'src/handler.ts',
      line: 12,
      arguments: '["input"]',
      kind: 'direct',
    });

    const callers = store.findCallers('processData');
    expect(callers).toHaveLength(1);
    expect(callers[0]!.file).toBe('src/handler.ts');
  });

  it('inserts and queries column references', () => {
    const symbolId = store.insertSymbol({
      name: 'updateBalance',
      kind: 'procedure',
      file: 'procs/update.sql',
      line: 1,
      language: 'sql',
    });

    store.insertColumn({
      symbolId,
      tableName: 'customer',
      columnName: 'balance',
      operation: 'UPDATE',
    });

    const refs = store.findColumnRefs('customer', 'balance');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.operation).toBe('UPDATE');
  });

  it('tracks file mtimes for incremental updates', () => {
    store.upsertFile('src/foo.ts', 1000, 'typescript');
    expect(store.getFileMtime('src/foo.ts')).toBe(1000);

    store.upsertFile('src/foo.ts', 2000, 'typescript');
    expect(store.getFileMtime('src/foo.ts')).toBe(2000);
  });

  it('clears symbols for a file on re-index', () => {
    store.insertSymbol({ name: 'old', kind: 'function', file: 'src/a.ts', line: 1, language: 'typescript' });
    store.clearFile('src/a.ts');
    expect(store.findSymbolsByName('old')).toHaveLength(0);
  });

  it('drops and rebuilds on schema version mismatch', () => {
    store.close();
    // Manually corrupt the version
    const Database = require('better-sqlite3');
    const db = new Database(join(dir, 'trace.db'));
    db.exec('UPDATE schema_version SET version = 999');
    db.close();

    // Re-open — should detect mismatch and rebuild
    const store2 = new TraceStore(dir);
    expect(store2.getSchemaVersion()).toBe(1);
    store2.close();
  });
});
