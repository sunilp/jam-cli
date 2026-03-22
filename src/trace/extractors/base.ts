import type Parser from 'tree-sitter';
import type { SymbolRecord, CallRecord, ImportRecord, ColumnRecord } from '../store.js';

/** Records extracted from a single file. */
export interface ExtractionResult {
  symbols: Omit<SymbolRecord, 'language'>[];
  calls: Array<{ callerName: string; calleeName: string; line: number; arguments?: string; kind?: string }>;
  imports: Omit<ImportRecord, 'file'>[];
  columns: Array<{ symbolName: string; tableName: string; columnName: string; operation: string }>;
}

/** Interface every language extractor must implement. */
export interface Extractor {
  language: string;
  extract(rootNode: Parser.SyntaxNode, source: string): ExtractionResult;
}

/** Registry of all available extractors. */
const extractors = new Map<string, Extractor>();

export function registerExtractor(extractor: Extractor): void {
  extractors.set(extractor.language, extractor);
}

export function getExtractor(language: string): Extractor | undefined {
  return extractors.get(language);
}

export function getAllExtractors(): Extractor[] {
  return Array.from(extractors.values());
}

/** Helper: walk all descendants of a node matching a type. */
export function findNodes(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode[] {
  const results: Parser.SyntaxNode[] = [];
  const walk = (n: Parser.SyntaxNode) => {
    if (n.type === type) results.push(n);
    for (let i = 0; i < n.childCount; i++) {
      walk(n.child(i)!);
    }
  };
  walk(node);
  return results;
}

/** Helper: walk descendants matching any of several types. */
export function findNodesByTypes(node: Parser.SyntaxNode, types: Set<string>): Parser.SyntaxNode[] {
  const results: Parser.SyntaxNode[] = [];
  const walk = (n: Parser.SyntaxNode) => {
    if (types.has(n.type)) results.push(n);
    for (let i = 0; i < n.childCount; i++) {
      walk(n.child(i)!);
    }
  };
  walk(node);
  return results;
}
