// src/trace/graph.ts
import type { TraceStore } from './store.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TraceResult {
  symbol: {
    id: number;
    name: string;
    kind: string;
    file: string;
    line: number;
    endLine?: number;
    signature?: string;
    returnType?: string;
    language: string;
  };
  callers: Array<{
    symbolName: string;
    symbolKind: string;
    file: string;
    line: number;
    arguments?: string;
    language: string;
  }>;
  callees: Array<{
    name: string;
    file?: string;
    line: number;
    arguments?: string;
  }>;
  imports: Array<{
    file: string;
    sourceModule: string;
    alias?: string;
  }>;
  upstreamChain: UpstreamNode[];
  notFound: boolean;
  candidates?: Array<{ name: string; file: string; kind: string }>;
}

export interface UpstreamNode {
  name: string;
  file: string;
  line: number;
  language: string;
  callers: UpstreamNode[];
}

// ── Internal DB row types (better-sqlite3 returns snake_case columns) ────────

interface DbSymbolRow {
  id: number;
  name: string;
  kind: string;
  file: string;
  line: number;
  end_line: number | null;
  signature: string | null;
  return_type: string | null;
  body_hash: string | null;
  language: string;
}

interface DbCallRow {
  id: number;
  caller_id: number;
  callee_name: string;
  file: string;
  line: number;
  arguments: string | null;
  kind: string;
}

interface DbImportRow {
  file: string;
  symbol_name: string;
  source_module: string;
  alias: string | null;
}

// ── Graph engine ─────────────────────────────────────────────────────────────

/**
 * Trace a symbol through the SQLite index, returning callers, callees,
 * imports, and the upstream call chain.
 */
export function traceSymbol(
  store: TraceStore,
  symbolName: string,
  options?: { depth?: number },
): TraceResult {
  const maxDepth = options?.depth ?? 10;

  // 1. Find the symbol
  const symbols = store.findSymbolsByName(symbolName);
  if (symbols.length === 0) {
    // Try fuzzy search for candidates
    const candidates = store.findSymbolsLike(symbolName).map((s) => {
      const row = s as unknown as DbSymbolRow;
      return { name: row.name, file: row.file, kind: row.kind };
    });
    return {
      symbol: { id: 0, name: symbolName, kind: 'unknown', file: '', line: 0, language: '' },
      callers: [],
      callees: [],
      imports: [],
      upstreamChain: [],
      notFound: true,
      candidates: candidates.length > 0 ? candidates : undefined,
    };
  }

  // Cast to actual DB row shape (better-sqlite3 returns snake_case columns)
  const sym = symbols[0] as unknown as DbSymbolRow;

  // 2. Find callers via calls table (callee_name -> resolve caller_id)
  const callRows = store.findCallers(symbolName) as unknown as DbCallRow[];
  const callers = callRows
    .map((call) => {
      const callerSym = store.findSymbolById(call.caller_id) as unknown as DbSymbolRow | undefined;
      if (!callerSym) return null;
      return {
        symbolName: callerSym.name,
        symbolKind: callerSym.kind,
        file: call.file,
        line: call.line,
        arguments: call.arguments ?? undefined,
        language: callerSym.language,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  // 3. Find callees (outgoing calls from this symbol)
  const calleeRows = store.findCallees(sym.id) as unknown as DbCallRow[];
  const callees = calleeRows.map((c) => ({
    name: c.callee_name,
    file: c.file || undefined,
    line: c.line,
    arguments: c.arguments ?? undefined,
  }));

  // 4. Find imports
  const importRows = store.findImportsBySymbol(symbolName) as unknown as DbImportRow[];
  const imports = importRows.map((imp) => ({
    file: imp.file,
    sourceModule: imp.source_module,
    alias: imp.alias ?? undefined,
  }));

  // 5. Build upstream chain (seed visited with the traced symbol to prevent cycles)
  const visited = new Set<string>([symbolName]);
  const upstreamChain = buildUpstream(store, symbolName, maxDepth, visited);

  return {
    symbol: {
      id: sym.id,
      name: sym.name,
      kind: sym.kind,
      file: sym.file,
      line: sym.line,
      endLine: sym.end_line ?? undefined,
      signature: sym.signature ?? undefined,
      returnType: sym.return_type ?? undefined,
      language: sym.language,
    },
    callers,
    callees,
    imports,
    upstreamChain,
    notFound: false,
  };
}

/**
 * Recursively build upstream caller chain with cycle detection.
 */
function buildUpstream(
  store: TraceStore,
  symbolName: string,
  depth: number,
  visited: Set<string>,
): UpstreamNode[] {
  if (depth <= 0) return [];

  const callRows = store.findCallers(symbolName) as unknown as DbCallRow[];
  const nodes: UpstreamNode[] = [];

  // Deduplicate callers by symbol id
  const seenCallers = new Set<number>();

  for (const call of callRows) {
    if (seenCallers.has(call.caller_id)) continue;
    seenCallers.add(call.caller_id);

    const callerSym = store.findSymbolById(call.caller_id) as unknown as DbSymbolRow | undefined;
    if (!callerSym) continue;

    // Skip if already visited (cycle detection)
    if (visited.has(callerSym.name)) continue;
    visited.add(callerSym.name);

    // Recurse
    const subCallers = buildUpstream(store, callerSym.name, depth - 1, visited);

    nodes.push({
      name: callerSym.name,
      file: callerSym.file,
      line: callerSym.line,
      language: callerSym.language,
      callers: subCallers,
    });
  }

  return nodes;
}
