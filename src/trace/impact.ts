// src/trace/impact.ts
import type { TraceStore } from './store.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ImpactReport {
  symbol: { name: string; file: string; kind: string; language: string };
  directCallers: Array<{ name: string; file: string; line: number; language: string }>;
  columnDependents: Array<{
    symbolName: string;
    file: string;
    tableName: string;
    columnName: string;
    operation: string;
  }>;
  downstreamEffects: Array<{
    symbolName: string;
    file: string;
    tableName: string;
    columnName: string;
    operation: string;
  }>;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  riskReason: string;
}

// ── Internal DB row types (better-sqlite3 returns snake_case columns) ────────

interface DbSymbolRow {
  id: number;
  name: string;
  kind: string;
  file: string;
  line: number;
  language: string;
}

interface DbCallRow {
  id: number;
  caller_id: number;
  callee_name: string;
  file: string;
  line: number;
  arguments: string | null;
}

interface DbColumnRow {
  id: number;
  symbol_id: number;
  table_name: string;
  column_name: string;
  operation: string;
}

// ── Impact analysis ──────────────────────────────────────────────────────────

/**
 * Analyze the impact of changing a symbol — who calls it, what columns
 * it touches, and which other symbols share those columns.
 */
export function analyzeImpact(store: TraceStore, symbolName: string): ImpactReport {
  // 1. Find the symbol
  const symbols = store.findSymbolsByName(symbolName);
  if (symbols.length === 0) {
    return {
      symbol: { name: symbolName, file: '', kind: 'unknown', language: '' },
      directCallers: [],
      columnDependents: [],
      downstreamEffects: [],
      riskLevel: 'LOW',
      riskReason: 'Symbol not found in index',
    };
  }

  const sym = symbols[0] as unknown as DbSymbolRow;

  // 2. Find all direct callers
  const callRows = store.findCallers(symbolName) as unknown as DbCallRow[];
  const seenCallers = new Set<number>();
  const directCallers: ImpactReport['directCallers'] = [];

  for (const call of callRows) {
    if (seenCallers.has(call.caller_id)) continue;
    seenCallers.add(call.caller_id);

    const callerSym = store.findSymbolById(call.caller_id) as unknown as DbSymbolRow | undefined;
    if (!callerSym) continue;

    directCallers.push({
      name: callerSym.name,
      file: callerSym.file,
      line: call.line,
      language: callerSym.language,
    });
  }

  // 3. Find all columns this symbol touches
  const columnRefs = store.findColumnsBySymbolId(sym.id) as unknown as DbColumnRow[];

  // 4. For each column, find OTHER symbols that touch the same table+column
  const columnDependents: ImpactReport['columnDependents'] = [];
  const downstreamEffects: ImpactReport['downstreamEffects'] = [];
  const seenDependents = new Set<string>();

  for (const col of columnRefs) {
    const otherRefs = store.findColumnRefs(col.table_name, col.column_name) as unknown as DbColumnRow[];
    for (const other of otherRefs) {
      if (other.symbol_id === sym.id) continue;
      const key = `${other.symbol_id}:${other.table_name}:${other.column_name}`;
      if (seenDependents.has(key)) continue;
      seenDependents.add(key);

      const otherSym = store.findSymbolById(other.symbol_id) as unknown as DbSymbolRow | undefined;
      if (!otherSym) continue;

      const entry = {
        symbolName: otherSym.name,
        file: otherSym.file,
        tableName: other.table_name,
        columnName: other.column_name,
        operation: other.operation,
      };

      columnDependents.push(entry);

      // Downstream effects: symbols that READ columns this symbol WRITES
      if (
        (col.operation === 'UPDATE' || col.operation === 'INSERT' || col.operation === 'DELETE') &&
        (other.operation === 'SELECT' || other.operation === 'READ')
      ) {
        downstreamEffects.push(entry);
      }
    }
  }

  // 5. Calculate risk
  const { riskLevel, riskReason } = calculateRisk(directCallers, columnRefs.length, columnDependents, sym.language);

  return {
    symbol: { name: sym.name, file: sym.file, kind: sym.kind, language: sym.language },
    directCallers,
    columnDependents,
    downstreamEffects,
    riskLevel,
    riskReason,
  };
}

function calculateRisk(
  callers: ImpactReport['directCallers'],
  columnCount: number,
  dependents: ImpactReport['columnDependents'],
  symbolLanguage: string,
): { riskLevel: ImpactReport['riskLevel']; riskReason: string } {
  const callerCount = callers.length;
  const totalDependents = callerCount + dependents.length;

  // CRITICAL: 10+ total dependents
  if (totalDependents >= 10) {
    return {
      riskLevel: 'CRITICAL',
      riskReason: `${totalDependents} total dependents (${callerCount} callers, ${dependents.length} column dependents)`,
    };
  }

  // HIGH: 4+ callers, or 4+ columns, or cross-language callers
  const hasMultipleLanguages = callers.some((c) => c.language !== symbolLanguage);
  if (callerCount >= 4 || columnCount >= 4 || hasMultipleLanguages) {
    const reasons: string[] = [];
    if (callerCount >= 4) reasons.push(`${callerCount} direct callers`);
    if (columnCount >= 4) reasons.push(`${columnCount} column references`);
    if (hasMultipleLanguages) reasons.push('cross-language callers');
    return { riskLevel: 'HIGH', riskReason: reasons.join(', ') };
  }

  // MEDIUM: 2-3 callers or 1-3 columns
  if (callerCount >= 2 || (columnCount >= 1 && columnCount <= 3)) {
    const reasons: string[] = [];
    if (callerCount >= 2) reasons.push(`${callerCount} direct callers`);
    if (columnCount >= 1) reasons.push(`${columnCount} column references`);
    return { riskLevel: 'MEDIUM', riskReason: reasons.join(', ') };
  }

  // LOW: 0-1 callers, 0 columns
  return {
    riskLevel: 'LOW',
    riskReason: callerCount === 0
      ? 'No callers found'
      : `${callerCount} caller, no column references`,
  };
}
