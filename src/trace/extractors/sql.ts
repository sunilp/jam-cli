// src/trace/extractors/sql.ts
import type Parser from 'tree-sitter';
import { registerExtractor, findNodes } from './base.js';
import type { Extractor, ExtractionResult } from './base.js';

// ── Regex patterns (used as primary and fallback extraction) ──────────────────

const RE_CREATE_OBJECT =
  /CREATE\s+(?:OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|VIEW|TRIGGER)\s+(\w+)/gi;

const RE_CALL =
  /\bCALL\s+(\w+)/gi;

const RE_EXEC =
  /\b(?:EXEC|EXECUTE)\s+(\w+)/gi;

const RE_SELECT_FROM =
  /\bSELECT\s+([\s\S]+?)\s+FROM\s+(\w+)(?:\s|;|$)/gi;

const RE_UPDATE_SET =
  /\bUPDATE\s+(\w+)\s+SET\s+([\s\S]+?)(?:\s+WHERE\b|\s*;|$)/gi;

const RE_INSERT_INTO =
  /\bINSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/gi;

const RE_DELETE_FROM =
  /\bDELETE\s+FROM\s+(\w+)/gi;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse a comma-separated column list, stripping aliases and table qualifiers. */
function parseColumnList(raw: string): string[] {
  return raw
    .split(',')
    .map(col => col.trim())
    // Remove table qualifiers (table.col → col)
    .map(col => (col.includes('.') ? col.split('.').pop()! : col))
    // Remove AS aliases: col AS alias → col
    .map(col => col.split(/\s+AS\s+/i)[0]!.trim())
    // Remove surrounding backticks/quotes
    .map(col => col.replace(/^[`"'[]|[`"']]$/g, ''))
    .filter(col => col.length > 0 && col !== '*');
}

/** Find the enclosing CREATE symbol name for a node, or return '<module>'. */
function _enclosingSymbol(node: Parser.SyntaxNode): string {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    // tree-sitter-sql may use different node type names; check common ones
    const t = current.type;
    if (
      t === 'create_procedure_statement' ||
      t === 'create_function_statement' ||
      t === 'create_view_statement' ||
      t === 'create_trigger_statement'
    ) {
      // Try to find an identifier child
      for (let i = 0; i < current.childCount; i++) {
        const c = current.child(i);
        if (c && (c.type === 'identifier' || c.type === 'name')) return c.text;
      }
    }
    current = current.parent;
  }
  return '<module>';
}

// ── Regex-based extraction (always reliable regardless of grammar) ─────────────

function extractSymbolsRegex(source: string): ExtractionResult['symbols'] {
  const symbols: ExtractionResult['symbols'] = [];
  const lines = source.split('\n');

  // Build a line-offset map for fast line lookup
  const lineOffsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(lineOffsets[i]! + lines[i]!.length + 1);
  }

  function offsetToLine(offset: number): number {
    let lo = 0, hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineOffsets[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1; // 1-based
  }

  const re = new RegExp(RE_CREATE_OBJECT.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const kind = m[1]!.toLowerCase() as 'procedure' | 'function' | 'view' | 'trigger';
    const name = m[2]!;
    const line = offsetToLine(m.index);
    symbols.push({ name, kind, line });
  }

  return symbols;
}

function extractCallsRegex(source: string): ExtractionResult['calls'] {
  const calls: ExtractionResult['calls'] = [];
  const lines = source.split('\n');

  const lineOffsets: number[] = [0];
  for (let i = 0; i < lines.length; i++) {
    lineOffsets.push(lineOffsets[i]! + lines[i]!.length + 1);
  }

  function offsetToLine(offset: number): number {
    let lo = 0, hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineOffsets[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  const callRe = new RegExp(RE_CALL.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    calls.push({
      callerName: '<module>',
      calleeName: m[1]!,
      line: offsetToLine(m.index),
      kind: 'cross-language',
    });
  }

  const execRe = new RegExp(RE_EXEC.source, 'gi');
  while ((m = execRe.exec(source)) !== null) {
    calls.push({
      callerName: '<module>',
      calleeName: m[1]!,
      line: offsetToLine(m.index),
      kind: 'cross-language',
    });
  }

  return calls;
}

function extractColumnsRegex(source: string): ExtractionResult['columns'] {
  const columns: ExtractionResult['columns'] = [];

  // SELECT col1, col2 FROM table
  const selectRe = new RegExp(RE_SELECT_FROM.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = selectRe.exec(source)) !== null) {
    const colList = m[1]!.trim();
    const tableName = m[2]!;

    if (colList === '*') {
      // SELECT * FROM table — emit one wildcard record
      columns.push({ symbolName: '<module>', tableName, columnName: '*', operation: 'SELECT' });
    } else {
      for (const col of parseColumnList(colList)) {
        columns.push({ symbolName: '<module>', tableName, columnName: col, operation: 'SELECT' });
      }
    }
  }

  // UPDATE table SET col = ...
  const updateRe = new RegExp(RE_UPDATE_SET.source, 'gi');
  while ((m = updateRe.exec(source)) !== null) {
    const tableName = m[1]!;
    const setPart = m[2]!;

    // Parse assignment list: col1 = val1, col2 = val2
    const assignments = setPart.split(',');
    for (const assignment of assignments) {
      const colPart = assignment.split('=')[0]!.trim().replace(/^[`"'[]|[`"']]$/g, '');
      if (colPart) {
        columns.push({ symbolName: '<module>', tableName, columnName: colPart, operation: 'UPDATE' });
      }
    }
  }

  // INSERT INTO table (col1, col2)
  const insertRe = new RegExp(RE_INSERT_INTO.source, 'gi');
  while ((m = insertRe.exec(source)) !== null) {
    const tableName = m[1]!;
    const colList = m[2]!;
    for (const col of parseColumnList(colList)) {
      columns.push({ symbolName: '<module>', tableName, columnName: col, operation: 'INSERT' });
    }
  }

  // DELETE FROM table
  const deleteRe = new RegExp(RE_DELETE_FROM.source, 'gi');
  while ((m = deleteRe.exec(source)) !== null) {
    const tableName = m[1]!;
    columns.push({ symbolName: '<module>', tableName, columnName: '*', operation: 'DELETE' });
  }

  return columns;
}

// ── Tree-sitter-based extraction (best-effort; falls back to regex results) ───

/**
 * Attempt to extract symbols from the AST. Returns null if the grammar doesn't
 * produce the expected node types (triggering regex fallback).
 */
function tryExtractSymbolsFromAST(
  rootNode: Parser.SyntaxNode,
): ExtractionResult['symbols'] | null {
  const symbols: ExtractionResult['symbols'] = [];
  let found = false;

  const CREATE_TYPES = new Set([
    'create_procedure_statement',
    'create_function_statement',
    'create_view_statement',
    'create_trigger_statement',
    // Some grammars use generic names
    'create_procedure',
    'create_function',
    'create_view',
    'create_trigger',
  ]);

  const KIND_MAP: Record<string, string> = {
    create_procedure_statement: 'procedure',
    create_function_statement: 'function',
    create_view_statement: 'view',
    create_trigger_statement: 'trigger',
    create_procedure: 'procedure',
    create_function: 'function',
    create_view: 'view',
    create_trigger: 'trigger',
  };

  for (const node of findNodes(rootNode, 'statement')) {
    // Walk children looking for create_* sub-types
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (CREATE_TYPES.has(child.type)) {
        found = true;
        const kind = KIND_MAP[child.type] ?? 'function';
        // Find identifier child
        for (let j = 0; j < child.childCount; j++) {
          const c = child.child(j);
          if (c && (c.type === 'identifier' || c.type === 'name')) {
            symbols.push({
              name: c.text,
              kind,
              line: child.startPosition.row + 1,
              endLine: child.endPosition.row + 1,
            });
            break;
          }
        }
      }
    }
  }

  // Also try direct top-level create nodes
  for (const type of CREATE_TYPES) {
    for (const node of findNodes(rootNode, type)) {
      found = true;
      const kind = KIND_MAP[type] ?? 'function';
      for (let j = 0; j < node.childCount; j++) {
        const c = node.child(j);
        if (c && (c.type === 'identifier' || c.type === 'name')) {
          // Avoid duplicates
          if (!symbols.some(s => s.name === c.text && s.line === node.startPosition.row + 1)) {
            symbols.push({
              name: c.text,
              kind,
              line: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
            });
          }
          break;
        }
      }
    }
  }

  return found ? symbols : null;
}

// ── Main extractor class ──────────────────────────────────────────────────────

export class SqlExtractor implements Extractor {
  readonly language = 'sql';

  extract(rootNode: Parser.SyntaxNode, source: string): ExtractionResult {
    const imports: ExtractionResult['imports'] = [];

    // Always use regex for reliability (tree-sitter-sql v0.1.0 has limited node types)
    const symbols = extractSymbolsRegex(source);
    const calls = extractCallsRegex(source);
    const columns = extractColumnsRegex(source);

    // Attempt AST-based symbol extraction; merge if it found anything
    const astSymbols = tryExtractSymbolsFromAST(rootNode);
    if (astSymbols && astSymbols.length > 0) {
      // AST-found symbols are more precise (have endLine); replace regex symbols
      // but only for names that regex also found (to avoid phantom nodes)
      const regexNames = new Set(symbols.map(s => s.name));
      for (const s of astSymbols) {
        if (regexNames.has(s.name)) {
          const idx = symbols.findIndex(r => r.name === s.name);
          if (idx >= 0) symbols[idx] = s;
        }
      }
    }

    return { symbols, calls, imports, columns };
  }
}

registerExtractor(new SqlExtractor());
