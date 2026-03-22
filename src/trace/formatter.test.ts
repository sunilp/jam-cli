// src/trace/formatter.test.ts
import { describe, it, expect } from 'vitest';
import type { TraceResult, UpstreamNode } from './graph.js';
import type { ImpactReport } from './impact.js';
import {
  formatAsciiTree,
  formatMermaid,
  formatGraphForAI,
  formatImpactReport,
} from './formatter.js';

function makeTraceResult(overrides?: Partial<TraceResult>): TraceResult {
  return {
    symbol: {
      id: 1,
      name: 'processData',
      kind: 'function',
      file: 'src/processor.ts',
      line: 10,
      endLine: 25,
      signature: '(input: string)',
      returnType: 'Promise<Result>',
      language: 'typescript',
    },
    callers: [
      { symbolName: 'handleRequest', symbolKind: 'function', file: 'src/handler.ts', line: 12, arguments: 'req.body', language: 'typescript' },
      { symbolName: 'batchProcess', symbolKind: 'function', file: 'src/batch.ts', line: 20, language: 'typescript' },
    ],
    callees: [
      { name: 'sanitize', file: 'src/utils.ts', line: 3, arguments: 'input' },
      { name: 'validate', line: 5 },
    ],
    imports: [
      { file: 'src/handler.ts', sourceModule: './processor.js' },
      { file: 'src/batch.ts', sourceModule: './processor.js', alias: 'process' },
    ],
    upstreamChain: [
      {
        name: 'handleRequest',
        file: 'src/handler.ts',
        line: 5,
        language: 'typescript',
        callers: [
          { name: 'main', file: 'src/index.ts', line: 1, language: 'typescript', callers: [] },
        ],
      },
    ],
    notFound: false,
    ...overrides,
  };
}

function makeNotFoundResult(): TraceResult {
  return {
    symbol: { id: 0, name: 'missing', kind: 'unknown', file: '', line: 0, language: '' },
    callers: [],
    callees: [],
    imports: [],
    upstreamChain: [],
    notFound: true,
    candidates: [
      { name: 'missingHandler', file: 'src/handler.ts', kind: 'function' },
    ],
  };
}

function makeImpactReport(overrides?: Partial<ImpactReport>): ImpactReport {
  return {
    symbol: { name: 'updateBalance', file: 'procs/update.sql', kind: 'procedure', language: 'sql' },
    directCallers: [
      { name: 'paymentService', file: 'src/payment.ts', line: 10, language: 'typescript' },
    ],
    columnDependents: [
      { symbolName: 'getBalance', file: 'src/balance.ts', tableName: 'users', columnName: 'balance', operation: 'SELECT' },
    ],
    downstreamEffects: [
      { symbolName: 'getBalance', file: 'src/balance.ts', tableName: 'users', columnName: 'balance', operation: 'SELECT' },
    ],
    riskLevel: 'HIGH',
    riskReason: 'cross-language callers',
    ...overrides,
  };
}

describe('formatAsciiTree', () => {
  it('renders header with signature and return type', () => {
    const result = makeTraceResult();
    const output = formatAsciiTree(result);

    expect(output).toContain('processData(input: string)');
    expect(output).toContain('Promise<Result>');
    expect(output).toContain('Defined: src/processor.ts:10  [function]');
  });

  it('renders callers section', () => {
    const output = formatAsciiTree(makeTraceResult());

    expect(output).toContain('Called from:');
    expect(output).toContain('handleRequest [function] src/handler.ts:12');
    expect(output).toContain('args: (req.body)');
    expect(output).toContain('batchProcess [function] src/batch.ts:20');
  });

  it('renders callees section', () => {
    const output = formatAsciiTree(makeTraceResult());

    expect(output).toContain('Calls into:');
    expect(output).toContain('sanitize(input) [src/utils.ts]');
    expect(output).toContain('validate()');
  });

  it('renders imports section', () => {
    const output = formatAsciiTree(makeTraceResult());

    expect(output).toContain('Imported by:');
    expect(output).toContain('src/handler.ts (from ./processor.js)');
    expect(output).toContain('src/batch.ts (from ./processor.js as process)');
  });

  it('renders upstream chain', () => {
    const output = formatAsciiTree(makeTraceResult());

    expect(output).toContain('Upstream call chain:');
    expect(output).toContain('handleRequest (src/handler.ts:5)');
    expect(output).toContain('main (src/index.ts:1)');
  });

  it('renders not-found message with candidates', () => {
    const output = formatAsciiTree(makeNotFoundResult());

    expect(output).toContain('Symbol not found: missing');
    expect(output).toContain('Did you mean:');
    expect(output).toContain('missingHandler (function) in src/handler.ts');
  });

  it('handles empty callers/callees/imports gracefully', () => {
    const result = makeTraceResult({
      callers: [],
      callees: [],
      imports: [],
      upstreamChain: [],
    });
    const output = formatAsciiTree(result);

    expect(output).toContain('processData(input: string)');
    expect(output).not.toContain('Called from:');
    expect(output).not.toContain('Calls into:');
    expect(output).not.toContain('Imported by:');
    expect(output).not.toContain('Upstream');
  });
});

describe('formatMermaid', () => {
  it('starts with graph TD', () => {
    const output = formatMermaid(makeTraceResult());
    expect(output).toMatch(/^graph TD/);
  });

  it('includes the traced symbol as a node', () => {
    const output = formatMermaid(makeTraceResult());
    expect(output).toContain('<b>processData</b>');
    expect(output).toContain('processor.ts:10');
  });

  it('includes caller nodes with arrows', () => {
    const output = formatMermaid(makeTraceResult());
    expect(output).toContain('handleRequest');
    expect(output).toContain('-->');
  });

  it('includes callee nodes', () => {
    const output = formatMermaid(makeTraceResult());
    expect(output).toContain('sanitize');
    expect(output).toContain('validate');
  });

  it('includes style directives', () => {
    const output = formatMermaid(makeTraceResult());
    expect(output).toContain('style');
    expect(output).toContain('fill:#2563eb');
  });

  it('renders not-found gracefully', () => {
    const output = formatMermaid(makeNotFoundResult());
    expect(output).toContain('graph TD');
    expect(output).toContain('Symbol not found');
  });
});

describe('formatGraphForAI', () => {
  it('starts with markdown heading', () => {
    const output = formatGraphForAI(makeTraceResult());
    expect(output).toMatch(/^# Call Graph: processData/);
  });

  it('includes definition metadata', () => {
    const output = formatGraphForAI(makeTraceResult());
    expect(output).toContain('**Definition:**');
    expect(output).toContain('src/processor.ts:10');
    expect(output).toContain('**Language:** typescript');
  });

  it('includes callers and callees', () => {
    const output = formatGraphForAI(makeTraceResult());
    expect(output).toContain('handleRequest');
    expect(output).toContain('sanitize');
  });

  it('includes upstream chain', () => {
    const output = formatGraphForAI(makeTraceResult());
    expect(output).toContain('main');
    expect(output).toContain('src/index.ts');
  });

  it('truncates when exceeding maxTokens', () => {
    // Create a result with many callers
    const manyCallers = Array.from({ length: 50 }, (_, i) => ({
      symbolName: `caller${i}`,
      symbolKind: 'function',
      file: `src/caller${i}.ts`,
      line: i + 1,
      language: 'typescript',
    }));

    const result = makeTraceResult({ callers: manyCallers });
    const output = formatGraphForAI(result, 500); // Very small budget

    // Should include truncation indicators
    expect(output).toContain('... and');
    expect(output).toContain('more callers');
  });

  it('renders not-found with candidates', () => {
    const output = formatGraphForAI(makeNotFoundResult());
    expect(output).toContain('# Symbol Not Found: missing');
    expect(output).toContain('Did you mean?');
    expect(output).toContain('missingHandler');
  });
});

describe('formatImpactReport', () => {
  it('includes risk badge in header', () => {
    const output = formatImpactReport(makeImpactReport());
    expect(output).toContain('Impact Analysis: updateBalance [HIGH]');
  });

  it('includes symbol metadata', () => {
    const output = formatImpactReport(makeImpactReport());
    expect(output).toContain('Symbol: updateBalance (procedure)');
    expect(output).toContain('File:   procs/update.sql');
    expect(output).toContain('Lang:   sql');
  });

  it('includes risk reason', () => {
    const output = formatImpactReport(makeImpactReport());
    expect(output).toContain('Risk:   HIGH');
    expect(output).toContain('cross-language callers');
  });

  it('includes direct callers', () => {
    const output = formatImpactReport(makeImpactReport());
    expect(output).toContain('Direct callers (1):');
    expect(output).toContain('paymentService (typescript) at src/payment.ts:10');
  });

  it('includes column dependents', () => {
    const output = formatImpactReport(makeImpactReport());
    expect(output).toContain('Column dependents (1):');
    expect(output).toContain('getBalance SELECTs users.balance');
  });

  it('includes downstream effects', () => {
    const output = formatImpactReport(makeImpactReport());
    expect(output).toContain('Downstream effects (1):');
    expect(output).toContain('getBalance reads users.balance');
  });

  it('handles empty callers', () => {
    const output = formatImpactReport(makeImpactReport({
      directCallers: [],
      columnDependents: [],
      downstreamEffects: [],
    }));
    expect(output).toContain('Direct callers: none');
    expect(output).not.toContain('Column dependents');
    expect(output).not.toContain('Downstream effects');
  });
});
