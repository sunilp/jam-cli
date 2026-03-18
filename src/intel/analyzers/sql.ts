import type { AnalyzerPlugin, FileAnalysis } from './base.js';
import type { IntelNode, IntelEdge } from '../types.js';

// CREATE TABLE [IF NOT EXISTS] table_name
const CREATE_TABLE_RE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?/gi;

// ALTER TABLE table_name
const ALTER_TABLE_RE = /ALTER\s+TABLE\s+[`"']?(\w+)[`"']?/gi;

// FOREIGN KEY ... REFERENCES table_name
const FK_REFERENCES_RE = /REFERENCES\s+[`"']?(\w+)[`"']?/gi;

// INSERT INTO table_name
const INSERT_RE = /INSERT\s+INTO\s+[`"']?(\w+)[`"']?/gi;

// SELECT ... FROM table_name (simple — first FROM after SELECT)
const SELECT_FROM_RE = /\bFROM\s+[`"']?(\w+)[`"']?/gi;

// dbt ref: {{ ref('model_name') }}
const DBT_REF_RE = /\{\{\s*ref\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g;

// dbt source: {{ source('src', 'table') }}
const DBT_SOURCE_RE = /\{\{\s*source\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g;

// Column extraction from CREATE TABLE body
function extractColumns(createStmt: string): string[] {
  // Find the body inside the parentheses
  const parenStart = createStmt.indexOf('(');
  if (parenStart === -1) return [];
  const parenEnd = createStmt.lastIndexOf(')');
  if (parenEnd === -1) return [];

  const body = createStmt.slice(parenStart + 1, parenEnd);
  const columns: string[] = [];

  // Each line that doesn't start with constraint keywords is a column
  const CONSTRAINT_KW = /^\s*(?:PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT|INDEX|KEY)\b/i;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || CONSTRAINT_KW.test(trimmed)) continue;
    // First word is column name (strip backticks/quotes)
    const colMatch = /^[`"']?(\w+)[`"']?/.exec(trimmed);
    if (colMatch) {
      columns.push(colMatch[1]!);
    }
  }
  return columns;
}

export class SqlAnalyzer implements AnalyzerPlugin {
  name = 'sql';
  languages = ['sql'];
  extensions = ['.sql'];

  analyzeFile(content: string, relPath: string, _rootDir: string): FileAnalysis {
    const nodes: IntelNode[] = [];
    const edges: IntelEdge[] = [];

    const fileId = `file:${relPath}`;

    // dbt layer detection from file path
    let dbtLayer: string | undefined;
    if (relPath.includes('models/staging/')) dbtLayer = 'staging';
    else if (relPath.includes('models/marts/')) dbtLayer = 'mart';

    // ── 1. File node ──────────────────────────────────────────────────────
    const fileMetadata: Record<string, unknown> = {};
    if (dbtLayer) fileMetadata['dbtLayer'] = dbtLayer;
    nodes.push({
      id: fileId,
      type: 'file',
      name: relPath,
      filePath: relPath,
      language: 'sql',
      metadata: fileMetadata,
    });

    // ── 2. CREATE TABLE → table nodes ─────────────────────────────────────
    // We need to capture the full CREATE TABLE statement to extract columns.
    // Strategy: find all CREATE TABLE positions and extract content up to first ';' or end.
    const knownTables = new Set<string>();
    const createPattern = new RegExp(CREATE_TABLE_RE.source, CREATE_TABLE_RE.flags);
    let createMatch: RegExpExecArray | null;
    while ((createMatch = createPattern.exec(content)) !== null) {
      const tableName = createMatch[1]!;
      knownTables.add(tableName.toUpperCase());

      // Extract columns by grabbing the statement from the match position
      const stmtStart = createMatch.index;
      const stmtEnd = content.indexOf(';', stmtStart);
      const stmtBody = stmtEnd !== -1 ? content.slice(stmtStart, stmtEnd + 1) : content.slice(stmtStart);
      const columns = extractColumns(stmtBody);

      const tableId = `table:${tableName}`;
      nodes.push({
        id: tableId,
        type: 'table',
        name: tableName,
        filePath: relPath,
        language: 'sql',
        metadata: { columns },
      });
      edges.push({ source: fileId, target: tableId, type: 'contains' });
    }

    // ── 3. ALTER TABLE → depends-on edges ────────────────────────────────
    const alterPattern = new RegExp(ALTER_TABLE_RE.source, ALTER_TABLE_RE.flags);
    let alterMatch: RegExpExecArray | null;
    while ((alterMatch = alterPattern.exec(content)) !== null) {
      const tableName = alterMatch[1]!;
      const tableId = `table:${tableName}`;
      edges.push({ source: fileId, target: tableId, type: 'depends-on' });
    }

    // ── 4. FOREIGN KEY REFERENCES → depends-on between tables ────────────
    // Strategy: find FK context — find the enclosing CREATE TABLE
    const fkPattern = new RegExp(FK_REFERENCES_RE.source, FK_REFERENCES_RE.flags);
    let fkMatch: RegExpExecArray | null;
    while ((fkMatch = fkPattern.exec(content)) !== null) {
      const referencedTable = fkMatch[1]!;
      // Find which CREATE TABLE contains this reference
      // Look backwards for the most recent CREATE TABLE
      const beforeFk = content.slice(0, fkMatch.index);
      const createMatches = [...beforeFk.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)[`"']?/gi)];
      if (createMatches.length > 0) {
        const sourceTable = createMatches[createMatches.length - 1]![1]!;
        edges.push({
          source: `table:${sourceTable}`,
          target: `table:${referencedTable}`,
          type: 'depends-on',
        });
      }
    }

    // ── 5. INSERT INTO → writes edges ─────────────────────────────────────
    const insertPattern = new RegExp(INSERT_RE.source, INSERT_RE.flags);
    let insertMatch: RegExpExecArray | null;
    while ((insertMatch = insertPattern.exec(content)) !== null) {
      const tableName = insertMatch[1]!;
      const tableId = `table:${tableName}`;
      // Ensure table node exists
      if (!knownTables.has(tableName.toUpperCase())) {
        knownTables.add(tableName.toUpperCase());
        nodes.push({
          id: tableId,
          type: 'table',
          name: tableName,
          filePath: relPath,
          language: 'sql',
          metadata: {},
        });
      }
      edges.push({ source: fileId, target: tableId, type: 'writes' });
    }

    // ── 6. SELECT FROM → reads edges ──────────────────────────────────────
    const seenReadTables = new Set<string>();
    const selectPattern = new RegExp(SELECT_FROM_RE.source, SELECT_FROM_RE.flags);
    let selectMatch: RegExpExecArray | null;
    while ((selectMatch = selectPattern.exec(content)) !== null) {
      const tableName = selectMatch[1]!;
      // Skip SQL keywords that can follow FROM
      if (['WHERE', 'JOIN', 'ON', 'SELECT', 'SET', 'VALUES', 'DUAL'].includes(tableName.toUpperCase())) continue;
      if (seenReadTables.has(tableName.toUpperCase())) continue;
      seenReadTables.add(tableName.toUpperCase());

      const tableId = `table:${tableName}`;
      if (!knownTables.has(tableName.toUpperCase())) {
        knownTables.add(tableName.toUpperCase());
        nodes.push({
          id: tableId,
          type: 'table',
          name: tableName,
          filePath: relPath,
          language: 'sql',
          metadata: {},
        });
      }
      edges.push({ source: fileId, target: tableId, type: 'reads' });
    }

    // ── 7. dbt ref() → depends-on edges ──────────────────────────────────
    const dbtRefPattern = new RegExp(DBT_REF_RE.source, DBT_REF_RE.flags);
    let dbtRefMatch: RegExpExecArray | null;
    while ((dbtRefMatch = dbtRefPattern.exec(content)) !== null) {
      const modelName = dbtRefMatch[1]!;
      const targetId = `file:${modelName}.sql`;
      edges.push({ source: fileId, target: targetId, type: 'depends-on' });
    }

    // ── 8. dbt source() → reads edges ────────────────────────────────────
    const dbtSrcPattern = new RegExp(DBT_SOURCE_RE.source, DBT_SOURCE_RE.flags);
    let dbtSrcMatch: RegExpExecArray | null;
    while ((dbtSrcMatch = dbtSrcPattern.exec(content)) !== null) {
      const srcName = dbtSrcMatch[1]!;
      const tableName = dbtSrcMatch[2]!;
      const targetId = `table:${srcName}.${tableName}`;
      edges.push({ source: fileId, target: targetId, type: 'reads' });
    }

    return { nodes, edges };
  }
}
