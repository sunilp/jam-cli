# Trace v2 Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace jam trace's regex engine with tree-sitter + SQLite for accurate call graphs, cross-language tracing, and impact analysis across TypeScript, Python, SQL, and Java codebases.

**Architecture:** Tree-sitter parses source files into ASTs. Per-language extractors emit Symbol/Call/Import/Column records into a SQLite index. The graph engine queries the index to build call graphs. The LLM analyzes the focused subgraph for semantic insights.

**Tech Stack:** tree-sitter (native, optional), better-sqlite3, vitest, TypeScript (ESM/NodeNext)

**Spec:** `docs/superpowers/specs/2026-03-22-trace-v2-design.md`

---

## File Map

```
CREATE:
  src/trace/store.ts          — SQLite wrapper (schema, read, write, migration)
  src/trace/store.test.ts     — Store tests
  src/trace/parser.ts         — tree-sitter wrapper (parse file → AST)
  src/trace/parser.test.ts    — Parser tests
  src/trace/extractors/base.ts       — ExtractorInterface + registry
  src/trace/extractors/typescript.ts  — TS/JS extractor
  src/trace/extractors/typescript.test.ts
  src/trace/extractors/python.ts      — Python extractor
  src/trace/extractors/python.test.ts
  src/trace/extractors/sql.ts         — SQL extractor (with column refs)
  src/trace/extractors/sql.test.ts
  src/trace/extractors/java.ts        — Java extractor
  src/trace/extractors/java.test.ts
  src/trace/indexer.ts        — Orchestrates parsing + extraction → writes to store
  src/trace/indexer.test.ts
  src/trace/graph.ts          — Call graph engine (queries index)
  src/trace/graph.test.ts
  src/trace/impact.ts         — Impact analysis engine
  src/trace/impact.test.ts
  src/trace/formatter.ts      — ASCII tree, Mermaid, JSON, AI context formatters
  src/trace/formatter.test.ts
  src/trace/index.ts          — Public API: buildIndex(), traceSymbol()

MODIFY:
  src/commands/trace.ts       — Rewire to new engine with fallback
  package.json                — Add better-sqlite3, tree-sitter deps

KEEP (fallback):
  src/utils/call-graph.ts     — Existing regex engine, used when tree-sitter unavailable
```

---

### Task 1: Add dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install better-sqlite3**

```bash
npm install better-sqlite3
npm install --save-dev @types/better-sqlite3
```

- [ ] **Step 2: Install tree-sitter and bundled grammars as optional deps**

```bash
npm install --save-optional tree-sitter tree-sitter-typescript tree-sitter-python tree-sitter-sql tree-sitter-java
```

Note: These are `optionalDependencies` — if native compilation fails, jam falls back to the regex engine.

- [ ] **Step 3: Verify build passes**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: No new errors, all existing 823 tests pass.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add better-sqlite3 and tree-sitter dependencies for trace v2"
```

---

### Task 2: SQLite store

**Files:**
- Create: `src/trace/store.ts`
- Create: `src/trace/store.test.ts`

- [ ] **Step 1: Write failing tests for store**

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/trace/store.test.ts
```

Expected: FAIL — module `./store.js` not found.

- [ ] **Step 3: Implement the store**

```typescript
// src/trace/store.ts
import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_VERSION = 1;

export interface SymbolRecord {
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine?: number;
  signature?: string;
  returnType?: string;
  bodyHash?: string;
  language: string;
}

export interface CallRecord {
  callerId: number;
  calleeName: string;
  file: string;
  line: number;
  arguments?: string;
  kind?: string;
}

export interface ImportRecord {
  file: string;
  symbolName: string;
  sourceModule: string;
  alias?: string;
}

export interface ColumnRecord {
  symbolId: number;
  tableName: string;
  columnName: string;
  operation: string;
}

export interface SymbolRow extends SymbolRecord {
  id: number;
}

export interface CallRow extends CallRecord {
  id: number;
}

export interface ColumnRow extends ColumnRecord {
  id: number;
}

export class TraceStore {
  private db: Database.Database;

  constructor(indexDir: string) {
    if (!existsSync(indexDir)) mkdirSync(indexDir, { recursive: true });
    const dbPath = join(indexDir, 'trace.db');
    try {
      this.db = new Database(dbPath);
    } catch {
      // Corruption detected — delete and recreate
      const { unlinkSync } = require('node:fs');
      try { unlinkSync(dbPath); } catch { /* may not exist */ }
      this.db = new Database(dbPath);
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.ensureSchema();
  }

  private ensureSchema(): void {
    // Check if schema_version table exists
    const hasVersion = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    ).get();

    if (hasVersion) {
      const row = this.db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
      if (row && row.version === SCHEMA_VERSION) return;
      // Version mismatch — drop everything and rebuild
      this.dropAll();
    }

    this.createTables();
  }

  private dropAll(): void {
    this.db.exec('DROP TABLE IF EXISTS columns');
    this.db.exec('DROP TABLE IF EXISTS calls');
    this.db.exec('DROP TABLE IF EXISTS imports');
    this.db.exec('DROP TABLE IF EXISTS symbols');
    this.db.exec('DROP TABLE IF EXISTS files');
    this.db.exec('DROP TABLE IF EXISTS schema_version');
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (${SCHEMA_VERSION});

      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        end_line INTEGER,
        signature TEXT,
        return_type TEXT,
        body_hash TEXT,
        language TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caller_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
        callee_name TEXT NOT NULL,
        file TEXT NOT NULL,
        line INTEGER NOT NULL,
        arguments TEXT,
        kind TEXT DEFAULT 'direct'
      );

      CREATE TABLE IF NOT EXISTS imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file TEXT NOT NULL,
        symbol_name TEXT NOT NULL,
        source_module TEXT NOT NULL,
        alias TEXT
      );

      CREATE TABLE IF NOT EXISTS columns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
        table_name TEXT NOT NULL,
        column_name TEXT NOT NULL,
        operation TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        mtime_ms INTEGER NOT NULL,
        language TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file);
      CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_name);
      CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_id);
      CREATE INDEX IF NOT EXISTS idx_columns_table ON columns(table_name, column_name);
      CREATE INDEX IF NOT EXISTS idx_imports_symbol ON imports(symbol_name);
    `);
  }

  getSchemaVersion(): number {
    const row = this.db.prepare('SELECT version FROM schema_version').get() as { version: number };
    return row.version;
  }

  insertSymbol(record: SymbolRecord): number {
    const stmt = this.db.prepare(
      `INSERT INTO symbols (name, kind, file, line, end_line, signature, return_type, body_hash, language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      record.name, record.kind, record.file, record.line,
      record.endLine ?? null, record.signature ?? null,
      record.returnType ?? null, record.bodyHash ?? null, record.language,
    );
    return Number(result.lastInsertRowid);
  }

  insertCall(record: CallRecord): void {
    this.db.prepare(
      `INSERT INTO calls (caller_id, callee_name, file, line, arguments, kind)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(record.callerId, record.calleeName, record.file, record.line,
      record.arguments ?? null, record.kind ?? 'direct');
  }

  insertImport(record: ImportRecord): void {
    this.db.prepare(
      `INSERT INTO imports (file, symbol_name, source_module, alias)
       VALUES (?, ?, ?, ?)`
    ).run(record.file, record.symbolName, record.sourceModule, record.alias ?? null);
  }

  insertColumn(record: ColumnRecord): void {
    this.db.prepare(
      `INSERT INTO columns (symbol_id, table_name, column_name, operation)
       VALUES (?, ?, ?, ?)`
    ).run(record.symbolId, record.tableName, record.columnName, record.operation);
  }

  findSymbolsByName(name: string): SymbolRow[] {
    return this.db.prepare('SELECT * FROM symbols WHERE name = ?').all(name) as SymbolRow[];
  }

  findSymbolById(id: number): SymbolRow | undefined {
    return this.db.prepare('SELECT * FROM symbols WHERE id = ?').get(id) as SymbolRow | undefined;
  }

  findSymbolsByFile(file: string): SymbolRow[] {
    return this.db.prepare('SELECT * FROM symbols WHERE file = ?').all(file) as SymbolRow[];
  }

  findCallers(calleeName: string): CallRow[] {
    return this.db.prepare('SELECT * FROM calls WHERE callee_name = ?').all(calleeName) as CallRow[];
  }

  findCallees(callerId: number): CallRow[] {
    return this.db.prepare('SELECT * FROM calls WHERE caller_id = ?').all(callerId) as CallRow[];
  }

  findColumnRefs(tableName: string, columnName?: string): ColumnRow[] {
    if (columnName) {
      return this.db.prepare(
        'SELECT * FROM columns WHERE table_name = ? AND column_name = ?'
      ).all(tableName, columnName) as ColumnRow[];
    }
    return this.db.prepare(
      'SELECT * FROM columns WHERE table_name = ?'
    ).all(tableName) as ColumnRow[];
  }

  upsertFile(path: string, mtimeMs: number, language: string): void {
    this.db.prepare(
      `INSERT INTO files (path, mtime_ms, language) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, language = excluded.language`
    ).run(path, mtimeMs, language);
  }

  getFileMtime(path: string): number | null {
    const row = this.db.prepare('SELECT mtime_ms FROM files WHERE path = ?').get(path) as { mtime_ms: number } | undefined;
    return row?.mtime_ms ?? null;
  }

  clearFile(file: string): void {
    // Delete symbols (cascades to calls and columns via ON DELETE CASCADE)
    const symbolIds = this.db.prepare('SELECT id FROM symbols WHERE file = ?').all(file) as Array<{ id: number }>;
    for (const { id } of symbolIds) {
      this.db.prepare('DELETE FROM calls WHERE caller_id = ?').run(id);
      this.db.prepare('DELETE FROM columns WHERE symbol_id = ?').run(id);
    }
    this.db.prepare('DELETE FROM symbols WHERE file = ?').run(file);
    this.db.prepare('DELETE FROM imports WHERE file = ?').run(file);
    this.db.prepare('DELETE FROM files WHERE path = ?').run(file);
  }

  getAllFiles(): Array<{ path: string; mtime_ms: number; language: string }> {
    return this.db.prepare('SELECT * FROM files').all() as Array<{ path: string; mtime_ms: number; language: string }>;
  }

  beginTransaction(): void {
    this.db.exec('BEGIN');
  }

  commitTransaction(): void {
    this.db.exec('COMMIT');
  }

  findImportsBySymbol(symbolName: string): ImportRecord[] {
    return this.db.prepare('SELECT * FROM imports WHERE symbol_name = ?').all(symbolName) as ImportRecord[];
  }

  findSymbolsLike(name: string): SymbolRow[] {
    return this.db.prepare(
      'SELECT * FROM symbols WHERE name LIKE ? COLLATE NOCASE LIMIT 10'
    ).all(`%${name}%`) as SymbolRow[];
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/trace/store.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trace/store.ts src/trace/store.test.ts
git commit -m "feat(trace): SQLite store with schema migration"
```

---

### Task 3: Tree-sitter parser wrapper

**Files:**
- Create: `src/trace/parser.ts`
- Create: `src/trace/parser.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/trace/parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseSource, isTreeSitterAvailable, detectLanguage } from './parser.js';

describe('detectLanguage', () => {
  it('detects TypeScript', () => expect(detectLanguage('foo.ts')).toBe('typescript'));
  it('detects TSX', () => expect(detectLanguage('foo.tsx')).toBe('typescript'));
  it('detects JavaScript', () => expect(detectLanguage('foo.js')).toBe('javascript'));
  it('detects Python', () => expect(detectLanguage('foo.py')).toBe('python'));
  it('detects SQL', () => expect(detectLanguage('foo.sql')).toBe('sql'));
  it('detects Java', () => expect(detectLanguage('foo.java')).toBe('java'));
  it('returns null for unknown', () => expect(detectLanguage('foo.rb')).toBeNull());
});

describe('parseSource', () => {
  it('parses TypeScript and returns AST root node', async () => {
    if (!isTreeSitterAvailable()) return; // skip if native addon not installed
    const tree = await parseSource('function hello() { return 1; }', 'typescript');
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('program');
    expect(tree!.rootNode.childCount).toBeGreaterThan(0);
  });

  it('parses Python', async () => {
    if (!isTreeSitterAvailable()) return;
    const tree = await parseSource('def hello():\n    return 1\n', 'python');
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('module');
  });

  it('parses SQL', async () => {
    if (!isTreeSitterAvailable()) return;
    const tree = await parseSource('SELECT id FROM users WHERE active = 1;', 'sql');
    expect(tree).not.toBeNull();
  });

  it('returns null for unsupported language', async () => {
    const tree = await parseSource('puts "hello"', 'ruby');
    expect(tree).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/trace/parser.test.ts
```

- [ ] **Step 3: Implement the parser**

```typescript
// src/trace/parser.ts
import type Parser from 'tree-sitter';

let TreeSitter: typeof Parser | null = null;
const grammars = new Map<string, Parser.Language>();

/** Check if tree-sitter native addon is available. */
export function isTreeSitterAvailable(): boolean {
  try {
    TreeSitter = require('tree-sitter');
    return true;
  } catch {
    return false;
  }
}

const LANG_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript',
  '.py': 'python',
  '.sql': 'sql',
  '.java': 'java',
};

const GRAMMAR_PACKAGES: Record<string, string> = {
  typescript: 'tree-sitter-typescript',
  javascript: 'tree-sitter-typescript', // uses typescript grammar's javascript sub-grammar
  python: 'tree-sitter-python',
  sql: 'tree-sitter-sql',
  java: 'tree-sitter-java',
};

/** Detect language from file extension. Returns null if unsupported. */
export function detectLanguage(filePath: string): string | null {
  const ext = filePath.substring(filePath.lastIndexOf('.'));
  return LANG_MAP[ext] ?? null;
}

/** Load a tree-sitter grammar for the given language. Caches loaded grammars. */
function loadGrammar(language: string): Parser.Language | null {
  if (grammars.has(language)) return grammars.get(language)!;

  const pkg = GRAMMAR_PACKAGES[language];
  if (!pkg) return null;

  try {
    // tree-sitter-typescript exports { typescript, tsx } for TS, and the JS grammar
    const mod = require(pkg);
    let grammar: Parser.Language;

    if (language === 'typescript') {
      grammar = mod.typescript ?? mod;
    } else if (language === 'javascript') {
      grammar = mod.javascript ?? mod;
    } else {
      grammar = mod;
    }

    grammars.set(language, grammar);
    return grammar;
  } catch {
    return null;
  }
}

/** Parse source code and return the tree. Returns null if grammar unavailable. */
export async function parseSource(
  source: string,
  language: string,
): Promise<Parser.Tree | null> {
  if (!TreeSitter && !isTreeSitterAvailable()) return null;

  const grammar = loadGrammar(language);
  if (!grammar) return null;

  const parser = new TreeSitter!();
  parser.setLanguage(grammar);
  return parser.parse(source);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/trace/parser.test.ts
```

Expected: PASS (or skip gracefully if tree-sitter not installed).

- [ ] **Step 5: Commit**

```bash
git add src/trace/parser.ts src/trace/parser.test.ts
git commit -m "feat(trace): tree-sitter parser wrapper with language detection"
```

---

### Task 4: Extractor base interface

**Files:**
- Create: `src/trace/extractors/base.ts`

- [ ] **Step 1: Define the extractor interface and registry**

```typescript
// src/trace/extractors/base.ts
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
```

- [ ] **Step 2: Commit**

```bash
git add src/trace/extractors/base.ts
git commit -m "feat(trace): extractor interface and AST walk helpers"
```

---

### Task 5: TypeScript extractor

**Files:**
- Create: `src/trace/extractors/typescript.ts`
- Create: `src/trace/extractors/typescript.test.ts`

- [ ] **Step 1: Write failing tests**

Tests should cover: function declarations, arrow functions, class methods, call expressions, import statements, export detection.

```typescript
// src/trace/extractors/typescript.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { isTreeSitterAvailable, parseSource } from '../parser.js';
import { TypeScriptExtractor } from './typescript.js';

const extractor = new TypeScriptExtractor();

function extract(source: string) {
  // Synchronous parse for tests — parseSource is async but fast
  return parseSource(source, 'typescript').then(tree => {
    if (!tree) throw new Error('Parse failed');
    return extractor.extract(tree.rootNode, source);
  });
}

describe('TypeScriptExtractor', () => {
  beforeAll(() => {
    if (!isTreeSitterAvailable()) {
      console.log('tree-sitter not available — skipping extractor tests');
    }
  });

  it('extracts exported function declarations', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract(
      'export async function processData(input: string): Promise<Result> {\n  return transform(input);\n}'
    );
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.name).toBe('processData');
    expect(result.symbols[0]!.kind).toBe('function');
  });

  it('extracts arrow functions assigned to const', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract('export const handler = (req: Request) => { fetch(url); };');
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.name).toBe('handler');
  });

  it('extracts class declarations and methods', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract(
      'export class UserService {\n  async getUser(id: number) { return db.query(id); }\n}'
    );
    const classSymbol = result.symbols.find(s => s.name === 'UserService');
    const methodSymbol = result.symbols.find(s => s.name === 'getUser');
    expect(classSymbol).toBeDefined();
    expect(classSymbol!.kind).toBe('class');
    expect(methodSymbol).toBeDefined();
    expect(methodSymbol!.kind).toBe('method');
  });

  it('extracts call expressions', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract(
      'function main() {\n  const x = processData("hello");\n  console.log(x);\n}'
    );
    const calls = result.calls.filter(c => c.calleeName === 'processData');
    expect(calls).toHaveLength(1);
  });

  it('extracts import statements', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract(
      "import { processData, type Result } from './processor.js';\nimport chalk from 'chalk';"
    );
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
    const pd = result.imports.find(i => i.symbolName === 'processData');
    expect(pd).toBeDefined();
    expect(pd!.sourceModule).toBe('./processor.js');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/trace/extractors/typescript.test.ts
```

- [ ] **Step 3: Implement the TypeScript extractor**

The extractor walks tree-sitter AST node types: `function_declaration`, `arrow_function`, `class_declaration`, `method_definition`, `call_expression`, `import_statement`. Uses `findNodes` and `findNodesByTypes` helpers from `base.ts`.

Implementation (~150 lines): Walk the AST root. For each `function_declaration`, emit a Symbol. For each `call_expression`, emit a Call. For each `import_statement`, emit an Import. Handle `export_statement` wrapping. Extract parameter list from `formal_parameters` node. Extract return type from `type_annotation` node.

Register with `registerExtractor(new TypeScriptExtractor())` at module load.

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/trace/extractors/typescript.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trace/extractors/typescript.ts src/trace/extractors/typescript.test.ts
git commit -m "feat(trace): TypeScript/JavaScript extractor"
```

---

### Task 6: Python extractor

**Files:**
- Create: `src/trace/extractors/python.ts`
- Create: `src/trace/extractors/python.test.ts`

Same pattern as Task 5. AST node types: `function_definition`, `class_definition`, `call`, `import_from_statement`, `import_statement`. Handle `decorated_definition` (functions with decorators).

- [ ] **Step 1: Write failing tests** — function defs, class defs, calls, imports, decorators
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement** — ~120 lines, same pattern as TS extractor
- [ ] **Step 4: Run tests** — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src/trace/extractors/python.ts src/trace/extractors/python.test.ts
git commit -m "feat(trace): Python extractor"
```

---

### Task 7: SQL extractor (with column refs)

**Files:**
- Create: `src/trace/extractors/sql.ts`
- Create: `src/trace/extractors/sql.test.ts`

This is the most important extractor for the cross-language story. Must extract: CREATE PROCEDURE/FUNCTION/VIEW/TRIGGER, EXECUTE/CALL statements, and column references from SELECT/INSERT/UPDATE/DELETE.

- [ ] **Step 1: Write failing tests**

```typescript
// src/trace/extractors/sql.test.ts
import { describe, it, expect } from 'vitest';
import { isTreeSitterAvailable, parseSource } from '../parser.js';
import { SqlExtractor } from './sql.js';

const extractor = new SqlExtractor();

describe('SqlExtractor', () => {
  it('extracts CREATE PROCEDURE as symbol', async () => {
    if (!isTreeSitterAvailable()) return;
    const tree = await parseSource(
      'CREATE PROCEDURE update_balance(p_id INT, p_amount DECIMAL)\nBEGIN\n  UPDATE customer SET balance = balance + p_amount WHERE id = p_id;\nEND;',
      'sql'
    );
    if (!tree) return;
    const result = extractor.extract(tree.rootNode, '');
    const proc = result.symbols.find(s => s.name === 'update_balance');
    expect(proc).toBeDefined();
    expect(proc!.kind).toBe('procedure');
  });

  it('extracts column references from UPDATE', async () => {
    if (!isTreeSitterAvailable()) return;
    const tree = await parseSource(
      'CREATE PROCEDURE update_balance()\nBEGIN\n  UPDATE customer SET balance = 100;\nEND;',
      'sql'
    );
    if (!tree) return;
    const result = extractor.extract(tree.rootNode, '');
    const cols = result.columns.filter(c => c.tableName.toLowerCase() === 'customer');
    expect(cols.length).toBeGreaterThanOrEqual(1);
    expect(cols.some(c => c.columnName.toLowerCase() === 'balance')).toBe(true);
  });

  it('extracts CALL/EXECUTE as cross-language calls', async () => {
    if (!isTreeSitterAvailable()) return;
    const tree = await parseSource('CALL process_payment(100, 50.00);', 'sql');
    if (!tree) return;
    const result = extractor.extract(tree.rootNode, '');
    const call = result.calls.find(c => c.calleeName.toLowerCase() === 'process_payment');
    expect(call).toBeDefined();
  });

  it('extracts CREATE VIEW as symbol', async () => {
    if (!isTreeSitterAvailable()) return;
    const tree = await parseSource(
      'CREATE VIEW v_active_customers AS SELECT id, name, balance FROM customer WHERE active = 1;',
      'sql'
    );
    if (!tree) return;
    const result = extractor.extract(tree.rootNode, '');
    expect(result.symbols.some(s => s.name === 'v_active_customers')).toBe(true);
  });
});
```

Note: tree-sitter-sql grammar quality may vary. If specific node types aren't recognized, the extractor should fall back to regex-based extraction for that construct and log a warning. Test against the actual grammar and adapt node type names accordingly.

- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement** — ~180 lines. Walk AST for `create_procedure`, `create_function`, `create_view`, `create_trigger` → symbols. Walk for `call_statement`, `execute_statement` → calls. Walk `select_statement`, `update_statement`, `insert_statement`, `delete_statement` for column refs.
- [ ] **Step 4: Run tests** — Expected: PASS (may need to adapt node types to actual grammar)
- [ ] **Step 5: Commit**

```bash
git add src/trace/extractors/sql.ts src/trace/extractors/sql.test.ts
git commit -m "feat(trace): SQL extractor with column reference tracking"
```

---

### Task 8: Java extractor

**Files:**
- Create: `src/trace/extractors/java.ts`
- Create: `src/trace/extractors/java.test.ts`

AST node types: `method_declaration`, `class_declaration`, `constructor_declaration`, `method_invocation`, `import_declaration`. Must also detect cross-language calls to SQL procedures (e.g., `callableStatement.execute("PROC_NAME")`).

- [ ] **Step 1: Write failing tests** — method declarations, class declarations, method invocations, imports, cross-language SQL calls
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement** — ~150 lines
- [ ] **Step 4: Run tests** — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src/trace/extractors/java.ts src/trace/extractors/java.test.ts
git commit -m "feat(trace): Java extractor with cross-language SQL detection"
```

---

### Task 9: Indexer (orchestrates parsing + extraction → store)

**Files:**
- Create: `src/trace/indexer.ts`
- Create: `src/trace/indexer.test.ts`

The indexer scans the workspace, parses each file with tree-sitter, runs the appropriate extractor, and writes records to the store. Handles incremental updates by checking file mtimes.

- [ ] **Step 1: Write failing tests**

```typescript
// src/trace/indexer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isTreeSitterAvailable } from './parser.js';
import { buildIndex } from './indexer.js';
import { TraceStore } from './store.js';

describe('buildIndex', () => {
  let workDir: string;
  let indexDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'trace-indexer-'));
    indexDir = join(workDir, '.jam', 'trace-index');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('indexes TypeScript files and populates store', async () => {
    if (!isTreeSitterAvailable()) return;

    mkdirSync(join(workDir, 'src'), { recursive: true });
    writeFileSync(join(workDir, 'src', 'processor.ts'), [
      'export async function processData(input: string): Promise<string> {',
      '  return sanitize(input);',
      '}',
      'function sanitize(s: string): string { return s.trim(); }',
    ].join('\n'));

    writeFileSync(join(workDir, 'src', 'handler.ts'), [
      "import { processData } from './processor.js';",
      'export function handleRequest(req: Request) {',
      '  return processData(req.body);',
      '}',
    ].join('\n'));

    const store = await buildIndex(workDir, indexDir);

    // Should find processData symbol
    const symbols = store.findSymbolsByName('processData');
    expect(symbols.length).toBeGreaterThanOrEqual(1);

    // Should find callers of processData
    const callers = store.findCallers('processData');
    expect(callers.length).toBeGreaterThanOrEqual(1);

    // Should find import of processData
    const imports = store.findImportsBySymbol('processData');
    expect(imports.length).toBeGreaterThanOrEqual(1);

    store.close();
  });

  it('performs incremental update (skips unchanged files)', async () => {
    if (!isTreeSitterAvailable()) return;

    writeFileSync(join(workDir, 'app.ts'), 'export function hello() {}');

    const store1 = await buildIndex(workDir, indexDir);
    const files1 = store1.getAllFiles();
    store1.close();

    // Re-index without changes — should be fast (no re-parsing)
    const store2 = await buildIndex(workDir, indexDir);
    const files2 = store2.getAllFiles();
    expect(files2.length).toBe(files1.length);
    store2.close();
  });

  it('indexes SQL files with column references', async () => {
    if (!isTreeSitterAvailable()) return;

    writeFileSync(join(workDir, 'schema.sql'), [
      'CREATE PROCEDURE update_user(p_id INT)',
      'BEGIN',
      '  UPDATE users SET name = "test" WHERE id = p_id;',
      'END;',
    ].join('\n'));

    const store = await buildIndex(workDir, indexDir);
    const symbols = store.findSymbolsByName('update_user');
    expect(symbols.length).toBeGreaterThanOrEqual(1);
    store.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement the indexer**

```typescript
// src/trace/indexer.ts
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { TraceStore } from './store.js';
import { parseSource, detectLanguage, isTreeSitterAvailable } from './parser.js';
import { getExtractor } from './extractors/base.js';

// Register all extractors on import
import './extractors/typescript.js';
import './extractors/python.js';
import './extractors/sql.js';
import './extractors/java.js';

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.jam', 'coverage',
  '__pycache__', '.next', '.nuxt', 'target', 'out', '.venv', 'venv',
]);

export async function buildIndex(
  workspaceRoot: string,
  indexDir: string,
): Promise<TraceStore> {
  const store = new TraceStore(indexDir);

  if (!isTreeSitterAvailable()) {
    return store; // Return empty store — caller should fall back to regex
  }

  const files = await collectFiles(workspaceRoot);

  // Wrap all inserts in a transaction for performance (100x faster for 10k+ files)
  store.beginTransaction();

  for (const filePath of files) {
    const relPath = relative(workspaceRoot, filePath);
    const language = detectLanguage(filePath);
    if (!language) continue;

    const extractor = getExtractor(language);
    if (!extractor) continue;

    // Check mtime for incremental update
    const fileStat = await stat(filePath);
    const mtimeMs = fileStat.mtimeMs;
    const storedMtime = store.getFileMtime(relPath);
    if (storedMtime !== null && storedMtime >= mtimeMs) continue; // Skip unchanged

    // Clear old records for this file
    store.clearFile(relPath);

    // Parse and extract
    const source = await readFile(filePath, 'utf-8');
    const tree = await parseSource(source, language);
    if (!tree) continue;

    const result = extractor.extract(tree.rootNode, source);

    // Write symbols
    const symbolIdMap = new Map<string, number>();
    for (const sym of result.symbols) {
      const id = store.insertSymbol({ ...sym, file: relPath, language });
      symbolIdMap.set(sym.name, id);
    }

    // Write calls (resolve caller name to id)
    for (const call of result.calls) {
      const callerId = symbolIdMap.get(call.callerName);
      if (callerId !== undefined) {
        store.insertCall({
          callerId,
          calleeName: call.calleeName,
          file: relPath,
          line: call.line,
          arguments: call.arguments,
          kind: call.kind,
        });
      }
    }

    // Write imports
    for (const imp of result.imports) {
      store.insertImport({ ...imp, file: relPath });
    }

    // Write column refs
    for (const col of result.columns) {
      const symbolId = symbolIdMap.get(col.symbolName);
      if (symbolId !== undefined) {
        store.insertColumn({
          symbolId,
          tableName: col.tableName,
          columnName: col.columnName,
          operation: col.operation,
        });
      }
    }

    // Update file mtime
    store.upsertFile(relPath, mtimeMs, language);
  }

  store.commitTransaction();

  return store;
}

async function collectFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(d: string) {
    const entries = await readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await walk(join(d, entry.name));
        }
      } else if (entry.isFile() && detectLanguage(entry.name)) {
        results.push(join(d, entry.name));
      }
    }
  }

  await walk(dir);
  return results;
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run src/trace/indexer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/trace/indexer.ts src/trace/indexer.test.ts
git commit -m "feat(trace): indexer — scans workspace, builds SQLite index"
```

---

### Task 10: Graph engine (queries index for call graphs)

**Files:**
- Create: `src/trace/graph.ts`
- Create: `src/trace/graph.test.ts`

Builds call graphs from the SQLite index. Produces the same `CallGraph` interface shape as the old `call-graph.ts` for compatibility with existing formatters.

- [ ] **Step 1: Write failing tests** — traceSymbol returns graph with callers, callees, upstream chain. Cross-language resolution. Symbol not found → candidates.
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement** — Query `symbols` by name, query `calls` for callers/callees, recursive upstream chain via `findCallers` → resolve `caller_id` to symbol → find its callers. Depth-limited traversal with visited set.
- [ ] **Step 4: Run tests** — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src/trace/graph.ts src/trace/graph.test.ts
git commit -m "feat(trace): graph engine — call graphs from SQLite index"
```

---

### Task 11: Impact analysis engine

**Files:**
- Create: `src/trace/impact.ts`
- Create: `src/trace/impact.test.ts`

Queries the index for: all upstream callers, all column dependents, views/triggers on the same tables.

- [ ] **Step 1: Write failing tests** — impact report includes direct callers, column dependents, downstream effects
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement** — Query callers (upstream), query `columns` table for same table/column refs, cross-reference symbols. Produce structured `ImpactReport` object.
- [ ] **Step 4: Run tests** — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src/trace/impact.ts src/trace/impact.test.ts
git commit -m "feat(trace): impact analysis engine"
```

---

### Task 12: Formatters (ASCII tree, Mermaid, JSON, AI context)

**Files:**
- Create: `src/trace/formatter.ts`
- Create: `src/trace/formatter.test.ts`

Migrate and enhance the formatting logic from `call-graph.ts`. Same output shapes but works with the new graph types. Add impact report formatting.

- [ ] **Step 1: Write failing tests** — ASCII tree output contains expected sections, Mermaid is valid, JSON is parseable, impact report formatted correctly
- [ ] **Step 2: Run tests to verify they fail**
- [ ] **Step 3: Implement** — Port `formatAsciiTree`, `formatMermaid`, `formatGraphForAI` from `call-graph.ts`, adapted for new types. Add `formatImpactReport` for `--impact` output.
- [ ] **Step 4: Run tests** — Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add src/trace/formatter.ts src/trace/formatter.test.ts
git commit -m "feat(trace): formatters — ASCII tree, Mermaid, JSON, impact report"
```

---

### Task 13: Public API and command rewiring

**Files:**
- Create: `src/trace/index.ts`
- Modify: `src/commands/trace.ts`

Wire the new engine into the `jam trace` command. Fall back to the old regex engine if tree-sitter is not available.

- [ ] **Step 1: Create public API**

```typescript
// src/trace/index.ts
export { buildIndex } from './indexer.js';
export { traceSymbol, type TraceResult } from './graph.js';
export { analyzeImpact, type ImpactReport } from './impact.js';
export { formatAsciiTree, formatMermaid, formatGraphForAI, formatImpactReport } from './formatter.js';
export { TraceStore } from './store.js';
export { isTreeSitterAvailable } from './parser.js';
```

- [ ] **Step 2: Modify trace command to use new engine with fallback**

In `src/commands/trace.ts`, change the imports and add a branch: if `isTreeSitterAvailable()`, use the new engine. Otherwise, fall back to the existing `buildCallGraph` from `call-graph.ts`.

Key changes:
- Add `--impact` flag handling
- Increase default depth from 3 to 10 (deeper traversal feasible with SQLite)
- Add `--reindex` flag → pass `forceReindex: true` to `buildIndex` (deletes existing index dir before building)
- Add `--lang` flag → passed to `detectLanguage` override
- Make `--json` and `--mermaid` mutually exclusive output modes (only one renders, not both)
- Add `--data-lineage` flag stub that prints "Data lineage is coming in Phase 2"
- Wrap AI analysis in try/catch → on failure, print "AI analysis unavailable — showing structural results only" and continue (don't exit)
- When symbol not found, call `store.findSymbolsLike(name)` and suggest candidates
- `formatGraphForAI`: truncate subgraph to ~8000 tokens before sending to LLM; if exceeded, include only immediate callers/callees and summarize deeper nodes as counts
- Keep all existing AI analysis logic (streaming, caching, markdown rendering) unchanged

- [ ] **Step 3: Update command registration in `src/index.ts`**

Add new flags to the trace command registration:
```typescript
.option('--impact', 'show what breaks if symbol changes')
.option('--reindex', 'force rebuild trace index')
.option('--lang <lang>', 'override language detection')
.option('--mermaid', 'output as Mermaid diagram')
```

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run
```

Expected: All tests pass (existing + new).

- [ ] **Step 5: Manual smoke test**

```bash
npm run build
node dist/index.js trace processData --depth 5
node dist/index.js trace processData --impact
node dist/index.js trace processData --mermaid
node dist/index.js trace processData --json
node dist/index.js trace processData --no-ai
```

- [ ] **Step 6: Commit**

```bash
git add src/trace/index.ts src/commands/trace.ts src/index.ts
git commit -m "feat(trace): wire v2 engine into jam trace command with fallback"
```

---

### Task 14: Cross-language integration test

**Files:**
- Create: `src/trace/cross-language.test.ts`

End-to-end test with a multi-language fixture: Java calls SQL procedure, SQL procedure references columns.

- [ ] **Step 1: Write the integration test**

Create a temp workspace with:
- `PaymentService.java` — has a method calling `callableStatement.execute("update_balance")`
- `procs/update_balance.sql` — CREATE PROCEDURE that UPDATE customer SET balance
- `views/v_summary.sql` — CREATE VIEW referencing customer.balance

Build the index. Trace `update_balance`. Verify:
- Java caller is found (cross-language)
- Column references are tracked
- Impact report includes the view

- [ ] **Step 2: Run tests** — Expected: PASS
- [ ] **Step 3: Commit**

```bash
git add src/trace/cross-language.test.ts
git commit -m "test(trace): cross-language integration test (Java → SQL → columns)"
```

---

### Task 15: Final verification and push

- [ ] **Step 1: Type-check**

```bash
npx tsc --noEmit
```

Expected: Exit 0.

- [ ] **Step 2: Full test suite**

```bash
npx vitest run
```

Expected: All tests pass.

- [ ] **Step 3: Build**

```bash
npm run build
```

- [ ] **Step 4: Smoke test on jam-cli codebase itself**

```bash
node dist/index.js trace createProvider --impact
node dist/index.js trace loadConfig --depth 8
node dist/index.js trace buildCallGraph
```

- [ ] **Step 5: Push**

```bash
git push
```
