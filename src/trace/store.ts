// src/trace/store.ts
import Database from 'better-sqlite3';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
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

  findColumnsBySymbolId(symbolId: number): ColumnRow[] {
    return this.db.prepare(
      'SELECT * FROM columns WHERE symbol_id = ?'
    ).all(symbolId) as ColumnRow[];
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
