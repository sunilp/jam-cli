// src/trace/impact.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TraceStore } from './store.js';
import { analyzeImpact } from './impact.js';

describe('analyzeImpact', () => {
  let dir: string;
  let store: TraceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trace-impact-'));
    store = new TraceStore(dir);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns LOW risk for symbol with no callers', () => {
    store.insertSymbol({
      name: 'isolated',
      kind: 'function',
      file: 'src/isolated.ts',
      line: 1,
      language: 'typescript',
    });

    const report = analyzeImpact(store, 'isolated');

    expect(report.symbol.name).toBe('isolated');
    expect(report.directCallers).toHaveLength(0);
    expect(report.riskLevel).toBe('LOW');
    expect(report.riskReason).toContain('No callers');
  });

  it('returns LOW risk for symbol with 1 caller and 0 columns', () => {
    store.insertSymbol({
      name: 'helper',
      kind: 'function',
      file: 'src/helper.ts',
      line: 1,
      language: 'typescript',
    });

    const callerId = store.insertSymbol({
      name: 'main',
      kind: 'function',
      file: 'src/main.ts',
      line: 1,
      language: 'typescript',
    });

    store.insertCall({ callerId, calleeName: 'helper', file: 'src/main.ts', line: 5 });

    const report = analyzeImpact(store, 'helper');
    expect(report.directCallers).toHaveLength(1);
    expect(report.riskLevel).toBe('LOW');
  });

  it('returns MEDIUM risk for symbol with 2-3 callers', () => {
    store.insertSymbol({
      name: 'shared',
      kind: 'function',
      file: 'src/shared.ts',
      line: 1,
      language: 'typescript',
    });

    // Add 3 callers
    for (let i = 0; i < 3; i++) {
      const callerId = store.insertSymbol({
        name: `caller${i}`,
        kind: 'function',
        file: `src/caller${i}.ts`,
        line: 1,
        language: 'typescript',
      });
      store.insertCall({ callerId, calleeName: 'shared', file: `src/caller${i}.ts`, line: 5 });
    }

    const report = analyzeImpact(store, 'shared');
    expect(report.directCallers).toHaveLength(3);
    expect(report.riskLevel).toBe('MEDIUM');
  });

  it('returns MEDIUM risk for symbol with column references', () => {
    const symId = store.insertSymbol({
      name: 'getUser',
      kind: 'function',
      file: 'src/user.ts',
      line: 1,
      language: 'typescript',
    });

    store.insertColumn({
      symbolId: symId,
      tableName: 'users',
      columnName: 'email',
      operation: 'SELECT',
    });

    const report = analyzeImpact(store, 'getUser');
    expect(report.riskLevel).toBe('MEDIUM');
    expect(report.riskReason).toContain('column');
  });

  it('returns HIGH risk for symbol with 4+ callers', () => {
    store.insertSymbol({
      name: 'utility',
      kind: 'function',
      file: 'src/utility.ts',
      line: 1,
      language: 'typescript',
    });

    for (let i = 0; i < 5; i++) {
      const callerId = store.insertSymbol({
        name: `user${i}`,
        kind: 'function',
        file: `src/user${i}.ts`,
        line: 1,
        language: 'typescript',
      });
      store.insertCall({ callerId, calleeName: 'utility', file: `src/user${i}.ts`, line: 5 });
    }

    const report = analyzeImpact(store, 'utility');
    expect(report.directCallers).toHaveLength(5);
    expect(report.riskLevel).toBe('HIGH');
  });

  it('returns HIGH risk for cross-language callers', () => {
    store.insertSymbol({
      name: 'update_user',
      kind: 'procedure',
      file: 'procs/update.sql',
      line: 1,
      language: 'sql',
    });

    const callerId = store.insertSymbol({
      name: 'userService',
      kind: 'function',
      file: 'src/service.ts',
      line: 1,
      language: 'typescript',
    });

    store.insertCall({
      callerId,
      calleeName: 'update_user',
      file: 'src/service.ts',
      line: 10,
    });

    const report = analyzeImpact(store, 'update_user');
    expect(report.riskLevel).toBe('HIGH');
    expect(report.riskReason).toContain('cross-language');
  });

  it('returns CRITICAL risk for 10+ dependents', () => {
    store.insertSymbol({
      name: 'coreLib',
      kind: 'function',
      file: 'src/core.ts',
      line: 1,
      language: 'typescript',
    });

    for (let i = 0; i < 10; i++) {
      const callerId = store.insertSymbol({
        name: `consumer${i}`,
        kind: 'function',
        file: `src/consumer${i}.ts`,
        line: 1,
        language: 'typescript',
      });
      store.insertCall({ callerId, calleeName: 'coreLib', file: `src/consumer${i}.ts`, line: 5 });
    }

    const report = analyzeImpact(store, 'coreLib');
    expect(report.directCallers).toHaveLength(10);
    expect(report.riskLevel).toBe('CRITICAL');
  });

  it('finds column dependents — other symbols touching same columns', () => {
    // SQL procedure that writes to users.balance
    const procId = store.insertSymbol({
      name: 'updateBalance',
      kind: 'procedure',
      file: 'procs/update.sql',
      line: 1,
      language: 'sql',
    });

    store.insertColumn({
      symbolId: procId,
      tableName: 'users',
      columnName: 'balance',
      operation: 'UPDATE',
    });

    // TypeScript function that reads users.balance
    const readerId = store.insertSymbol({
      name: 'getBalance',
      kind: 'function',
      file: 'src/balance.ts',
      line: 1,
      language: 'typescript',
    });

    store.insertColumn({
      symbolId: readerId,
      tableName: 'users',
      columnName: 'balance',
      operation: 'SELECT',
    });

    // Another function that also reads users.balance
    const reportId = store.insertSymbol({
      name: 'generateReport',
      kind: 'function',
      file: 'src/report.ts',
      line: 1,
      language: 'typescript',
    });

    store.insertColumn({
      symbolId: reportId,
      tableName: 'users',
      columnName: 'balance',
      operation: 'SELECT',
    });

    // A TypeScript caller of updateBalance
    const serviceId = store.insertSymbol({
      name: 'paymentService',
      kind: 'function',
      file: 'src/payment.ts',
      line: 1,
      language: 'typescript',
    });

    store.insertCall({
      callerId: serviceId,
      calleeName: 'updateBalance',
      file: 'src/payment.ts',
      line: 10,
    });

    const report = analyzeImpact(store, 'updateBalance');

    // Direct caller
    expect(report.directCallers).toHaveLength(1);
    expect(report.directCallers[0]!.name).toBe('paymentService');

    // Column dependents: getBalance and generateReport share users.balance
    expect(report.columnDependents).toHaveLength(2);
    const depNames = report.columnDependents.map(d => d.symbolName).sort();
    expect(depNames).toEqual(['generateReport', 'getBalance']);

    // Downstream effects: updateBalance UPDATES balance, getBalance/generateReport SELECT it
    expect(report.downstreamEffects).toHaveLength(2);
    for (const effect of report.downstreamEffects) {
      expect(effect.operation).toBe('SELECT');
      expect(effect.tableName).toBe('users');
      expect(effect.columnName).toBe('balance');
    }

    // Risk should be HIGH (cross-language caller: typescript calling sql)
    expect(report.riskLevel).toBe('HIGH');
  });

  it('handles symbol not found', () => {
    const report = analyzeImpact(store, 'nonexistent');
    expect(report.symbol.kind).toBe('unknown');
    expect(report.riskLevel).toBe('LOW');
    expect(report.riskReason).toContain('not found');
  });
});
