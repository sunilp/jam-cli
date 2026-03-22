// src/trace/cross-language.test.ts
// Cross-language integration test: Java -> SQL procedure -> SQL view (column tracking)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TraceStore } from './store.js';
import { traceSymbol } from './graph.js';
import { analyzeImpact } from './impact.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

const JAVA_SOURCE = `
package com.example.payment;

import java.sql.CallableStatement;

public class PaymentService {
    private final CallableStatement callableStatement;

    public void processPayment(double amount) {
        callableStatement.execute("update_balance");
    }

    public void refundPayment(double amount) {
        callableStatement.execute("update_balance");
    }
}
`;

const SQL_PROC_SOURCE = `
CREATE PROCEDURE update_balance()
BEGIN
  UPDATE customer SET balance = 100;
END;
`;

const SQL_VIEW_SOURCE = `
CREATE VIEW v_summary AS
SELECT balance FROM customer;
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Populate the store with manually extracted data from the fixtures above.
 * This avoids requiring tree-sitter to be installed — the SQL extractor
 * uses regex fallback, and we simulate the Java extractor output directly.
 */
function populateStore(store: TraceStore): void {
  store.beginTransaction();

  // ── PaymentService.java symbols ──────────────────────────────────────────
  store.insertSymbol({
    name: 'PaymentService',
    kind: 'class',
    file: 'PaymentService.java',
    line: 6,
    language: 'java',
  });

  const processPaymentId = store.insertSymbol({
    name: 'processPayment',
    kind: 'method',
    file: 'PaymentService.java',
    line: 9,
    signature: '(double amount)',
    returnType: 'void',
    language: 'java',
  });

  const refundPaymentId = store.insertSymbol({
    name: 'refundPayment',
    kind: 'method',
    file: 'PaymentService.java',
    line: 13,
    signature: '(double amount)',
    returnType: 'void',
    language: 'java',
  });

  // Java methods call update_balance (cross-language)
  store.insertCall({
    callerId: processPaymentId,
    calleeName: 'update_balance',
    file: 'PaymentService.java',
    line: 10,
    kind: 'cross-language',
  });

  store.insertCall({
    callerId: refundPaymentId,
    calleeName: 'update_balance',
    file: 'PaymentService.java',
    line: 14,
    kind: 'cross-language',
  });

  // Java imports
  store.insertImport({
    file: 'PaymentService.java',
    symbolName: 'CallableStatement',
    sourceModule: 'java.sql.CallableStatement',
  });

  // ── procs/update_balance.sql symbols ────────────────────────────────────
  const updateBalanceId = store.insertSymbol({
    name: 'update_balance',
    kind: 'procedure',
    file: 'procs/update_balance.sql',
    line: 2,
    language: 'sql',
  });

  // The procedure UPDATEs customer.balance
  store.insertColumn({
    symbolId: updateBalanceId,
    tableName: 'customer',
    columnName: 'balance',
    operation: 'UPDATE',
  });

  // ── views/v_summary.sql symbols ─────────────────────────────────────────
  const vSummaryId = store.insertSymbol({
    name: 'v_summary',
    kind: 'view',
    file: 'views/v_summary.sql',
    line: 2,
    language: 'sql',
  });

  // The view SELECTs customer.balance
  store.insertColumn({
    symbolId: vSummaryId,
    tableName: 'customer',
    columnName: 'balance',
    operation: 'SELECT',
  });

  // Record files
  store.upsertFile('PaymentService.java', Date.now(), 'java');
  store.upsertFile('procs/update_balance.sql', Date.now(), 'sql');
  store.upsertFile('views/v_summary.sql', Date.now(), 'sql');

  store.commitTransaction();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('cross-language trace (Java -> SQL -> columns)', () => {
  let store: TraceStore;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = join(tmpdir(), `jam-cross-lang-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    // Write fixture files (for reference, not parsed by this test)
    writeFileSync(join(tmpDir, 'PaymentService.java'), JAVA_SOURCE);
    mkdirSync(join(tmpDir, 'procs'), { recursive: true });
    writeFileSync(join(tmpDir, 'procs', 'update_balance.sql'), SQL_PROC_SOURCE);
    mkdirSync(join(tmpDir, 'views'), { recursive: true });
    writeFileSync(join(tmpDir, 'views', 'v_summary.sql'), SQL_VIEW_SOURCE);

    // Create store and populate with extracted data
    const indexDir = join(tmpDir, '.jam', 'trace-index');
    store = new TraceStore(indexDir);
    populateStore(store);
  });

  afterAll(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('traces update_balance and finds Java callers', () => {
    const result = traceSymbol(store, 'update_balance', { depth: 5 });

    expect(result.notFound).toBe(false);
    expect(result.symbol.name).toBe('update_balance');
    expect(result.symbol.kind).toBe('procedure');
    expect(result.symbol.language).toBe('sql');
    expect(result.symbol.file).toBe('procs/update_balance.sql');

    // Two Java methods call this procedure
    expect(result.callers.length).toBe(2);

    const callerNames = result.callers.map(c => c.symbolName).sort();
    expect(callerNames).toEqual(['processPayment', 'refundPayment']);

    // Both callers are Java
    for (const caller of result.callers) {
      expect(caller.language).toBe('java');
      expect(caller.file).toBe('PaymentService.java');
    }
  });

  it('traces processPayment and finds cross-language callee', () => {
    const result = traceSymbol(store, 'processPayment', { depth: 5 });

    expect(result.notFound).toBe(false);
    expect(result.symbol.language).toBe('java');

    // processPayment calls update_balance
    expect(result.callees.length).toBeGreaterThanOrEqual(1);
    const calleeNames = result.callees.map(c => c.name);
    expect(calleeNames).toContain('update_balance');
  });

  it('impact analysis shows v_summary as column dependent of update_balance', () => {
    const report = analyzeImpact(store, 'update_balance');

    expect(report.symbol.name).toBe('update_balance');
    expect(report.symbol.language).toBe('sql');

    // Direct callers: processPayment and refundPayment
    expect(report.directCallers.length).toBe(2);
    const callerNames = report.directCallers.map(c => c.name).sort();
    expect(callerNames).toEqual(['processPayment', 'refundPayment']);

    // Column dependents: v_summary reads customer.balance which update_balance writes
    expect(report.columnDependents.length).toBeGreaterThanOrEqual(1);
    const depNames = report.columnDependents.map(d => d.symbolName);
    expect(depNames).toContain('v_summary');

    // The dependent references customer.balance
    const vSummaryDep = report.columnDependents.find(d => d.symbolName === 'v_summary');
    expect(vSummaryDep).toBeDefined();
    expect(vSummaryDep!.tableName).toBe('customer');
    expect(vSummaryDep!.columnName).toBe('balance');
    expect(vSummaryDep!.operation).toBe('SELECT');

    // Downstream effects: v_summary reads a column that update_balance writes
    expect(report.downstreamEffects.length).toBeGreaterThanOrEqual(1);
    const effectNames = report.downstreamEffects.map(e => e.symbolName);
    expect(effectNames).toContain('v_summary');
  });

  it('impact analysis calculates correct risk level', () => {
    const report = analyzeImpact(store, 'update_balance');

    // 2 direct callers (Java) + 1 column dependent (v_summary) = cross-language
    // Cross-language callers => HIGH risk
    expect(report.riskLevel).toBe('HIGH');
    expect(report.riskReason).toContain('cross-language');
  });

  it('upstream chain walks from update_balance through Java callers', () => {
    const result = traceSymbol(store, 'update_balance', { depth: 3 });

    // Upstream chain should include processPayment and refundPayment
    expect(result.upstreamChain.length).toBe(2);
    const upstreamNames = result.upstreamChain.map(n => n.name).sort();
    expect(upstreamNames).toEqual(['processPayment', 'refundPayment']);

    // Upstream nodes should have correct language
    for (const node of result.upstreamChain) {
      expect(node.language).toBe('java');
    }
  });

  it('symbol not found returns candidates when partial match exists', () => {
    // "update_bal" is a substring of "update_balance", so LIKE %update_bal% matches
    const result = traceSymbol(store, 'update_bal', { depth: 3 });

    expect(result.notFound).toBe(true);
    expect(result.candidates).toBeDefined();
    expect(result.candidates!.length).toBeGreaterThanOrEqual(1);
    expect(result.candidates!.some(c => c.name === 'update_balance')).toBe(true);
  });
});
