/**
 * Symbol index builder — lightweight file→symbol mapping for faster retrieval.
 *
 * Scans source files for exported symbols (functions, classes, interfaces,
 * types, constants) and builds an index file at `.jam/symbol-index.json`.
 *
 * The index is used by the planner and enrichment stages to suggest specific
 * files to the model based on symbol names, reducing wasted search rounds.
 */

import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SymbolEntry {
  /** Symbol name (function, class, interface, variable name). */
  name: string;
  /** Kind of symbol. */
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'enum' | 'variable';
  /** File path relative to workspace root. */
  file: string;
  /** 1-based line number where the symbol is defined. */
  line: number;
}

export interface SymbolIndex {
  /** When the index was built (ISO timestamp). */
  builtAt: string;
  /** Number of files scanned. */
  filesScanned: number;
  /** Total symbols found. */
  totalSymbols: number;
  /** All symbol entries. */
  symbols: SymbolEntry[];
}

// ── File scanning ─────────────────────────────────────────────────────────────

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.jam', 'coverage',
  '__pycache__', '.next', '.nuxt', 'target', 'out', '.venv', 'venv',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
]);

/**
 * Recursively collect all source files in a workspace.
 */
async function collectSourceFiles(
  dir: string,
  rootDir: string,
  files: string[] = [],
  maxFiles: number = 500,
): Promise<string[]> {
  if (files.length >= maxFiles) return files;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (files.length >= maxFiles) break;
    const name = String(entry.name);

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(name) && !name.startsWith('.')) {
        await collectSourceFiles(join(dir, name), rootDir, files, maxFiles);
      }
    } else if (CODE_EXTENSIONS.has(extname(name))) {
      files.push(join(dir, name));
    }
  }

  return files;
}

// ── Symbol extraction (TypeScript / JavaScript) ───────────────────────────────

/**
 * Extract exported symbols from a TypeScript/JavaScript file using regex.
 * This is intentionally simple — no AST parsing needed for an index.
 */
function extractTsSymbols(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // export function foo(
    const funcMatch = line.match(/export\s+(?:async\s+)?function\s+(\w+)/);
    if (funcMatch) {
      symbols.push({ name: funcMatch[1]!, kind: 'function', file: filePath, line: lineNum });
      continue;
    }

    // export class Foo
    const classMatch = line.match(/export\s+(?:abstract\s+)?class\s+(\w+)/);
    if (classMatch) {
      symbols.push({ name: classMatch[1]!, kind: 'class', file: filePath, line: lineNum });
      continue;
    }

    // export interface Foo
    const ifaceMatch = line.match(/export\s+interface\s+(\w+)/);
    if (ifaceMatch) {
      symbols.push({ name: ifaceMatch[1]!, kind: 'interface', file: filePath, line: lineNum });
      continue;
    }

    // export type Foo =
    const typeMatch = line.match(/export\s+type\s+(\w+)/);
    if (typeMatch) {
      symbols.push({ name: typeMatch[1]!, kind: 'type', file: filePath, line: lineNum });
      continue;
    }

    // export enum Foo
    const enumMatch = line.match(/export\s+enum\s+(\w+)/);
    if (enumMatch) {
      symbols.push({ name: enumMatch[1]!, kind: 'enum', file: filePath, line: lineNum });
      continue;
    }

    // export const FOO = / export const foo =
    const constMatch = line.match(/export\s+const\s+(\w+)/);
    if (constMatch) {
      symbols.push({ name: constMatch[1]!, kind: 'const', file: filePath, line: lineNum });
      continue;
    }

    // Non-exported but significant: class Foo
    const plainClassMatch = line.match(/^(?:abstract\s+)?class\s+(\w+)/);
    if (plainClassMatch && !line.includes('export')) {
      symbols.push({ name: plainClassMatch[1]!, kind: 'class', file: filePath, line: lineNum });
      continue;
    }
  }

  return symbols;
}

/**
 * Extract symbols from a Python file.
 */
function extractPySymbols(content: string, filePath: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // def foo( — top-level only (no leading whitespace)
    const funcMatch = line.match(/^(?:async\s+)?def\s+(\w+)/);
    if (funcMatch) {
      symbols.push({ name: funcMatch[1]!, kind: 'function', file: filePath, line: lineNum });
      continue;
    }

    // class Foo
    const classMatch = line.match(/^class\s+(\w+)/);
    if (classMatch) {
      symbols.push({ name: classMatch[1]!, kind: 'class', file: filePath, line: lineNum });
      continue;
    }
  }

  return symbols;
}

// ── Index builder ─────────────────────────────────────────────────────────────

const INDEX_DIR = '.jam';
const INDEX_FILE = 'symbol-index.json';

/**
 * Build a symbol index for the workspace.
 * Scans all source files and extracts exported symbols.
 */
export async function buildSymbolIndex(workspaceRoot: string): Promise<SymbolIndex> {
  const files = await collectSourceFiles(workspaceRoot, workspaceRoot);
  const allSymbols: SymbolEntry[] = [];

  for (const absPath of files) {
    let content: string;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch {
      continue;
    }

    const relPath = relative(workspaceRoot, absPath);
    const ext = extname(absPath);

    let symbols: SymbolEntry[];
    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      symbols = extractTsSymbols(content, relPath);
    } else if (ext === '.py') {
      symbols = extractPySymbols(content, relPath);
    } else {
      // Skip unsupported languages for now
      continue;
    }

    allSymbols.push(...symbols);
  }

  const index: SymbolIndex = {
    builtAt: new Date().toISOString(),
    filesScanned: files.length,
    totalSymbols: allSymbols.length,
    symbols: allSymbols,
  };

  // Write index to disk
  const indexDir = join(workspaceRoot, INDEX_DIR);
  await mkdir(indexDir, { recursive: true });
  await writeFile(
    join(indexDir, INDEX_FILE),
    JSON.stringify(index, null, 2),
    'utf-8',
  );

  return index;
}

/**
 * Load the cached symbol index from disk.
 * Returns null if no index exists or it's too stale.
 */
export async function loadSymbolIndex(
  workspaceRoot: string,
  maxAge: number = 30 * 60 * 1000, // 30 minutes
): Promise<SymbolIndex | null> {
  const indexPath = join(workspaceRoot, INDEX_DIR, INDEX_FILE);

  try {
    const fileStat = await stat(indexPath);
    const age = Date.now() - fileStat.mtimeMs;
    if (age > maxAge) return null; // Too stale

    const raw = await readFile(indexPath, 'utf-8');
    return JSON.parse(raw) as SymbolIndex;
  } catch {
    return null;
  }
}

/**
 * Load or build the symbol index (builds if missing/stale).
 */
export async function getOrBuildIndex(workspaceRoot: string): Promise<SymbolIndex> {
  const cached = await loadSymbolIndex(workspaceRoot);
  if (cached) return cached;
  return buildSymbolIndex(workspaceRoot);
}

/**
 * Search the symbol index for symbols matching a query.
 * Returns matching symbols sorted by relevance.
 */
export function searchSymbols(
  index: SymbolIndex,
  query: string,
  maxResults: number = 20,
): SymbolEntry[] {
  const lower = query.toLowerCase();
  const terms = lower.split(/\s+/).filter(t => t.length > 1);

  if (terms.length === 0) return [];

  // Score each symbol
  const scored = index.symbols.map(sym => {
    const nameLower = sym.name.toLowerCase();
    let score = 0;

    for (const term of terms) {
      if (nameLower === term) score += 10;       // Exact match
      else if (nameLower.includes(term)) score += 5;  // Partial match
      else if (sym.file.toLowerCase().includes(term)) score += 2; // File match
    }

    return { sym, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.sym);
}

/**
 * Format symbol search results for injection into context.
 */
export function formatSymbolResults(symbols: SymbolEntry[]): string {
  if (symbols.length === 0) return '';

  const lines = ['**Relevant symbols found in the codebase:**', ''];

  for (const sym of symbols) {
    lines.push(`- \`${sym.name}\` (${sym.kind}) → \`${sym.file}:${sym.line}\``);
  }

  return lines.join('\n');
}
