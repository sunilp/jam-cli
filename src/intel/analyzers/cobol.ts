import type { AnalyzerPlugin, FileAnalysis } from './base.js';
import type { IntelNode, IntelEdge } from '../types.js';

// PROGRAM-ID. NAME.
const PROGRAM_ID_RE = /PROGRAM-ID\s*\.\s*(\S+?)\s*\./i;

// COPY XXXX
const COPY_RE = /^\s*COPY\s+(\S+)/gim;

// CALL 'XXXX' or CALL "XXXX"
const CALL_RE = /\bCALL\s+['"]([^'"]+)['"]/gi;

// EXEC SQL ... END-EXEC (multiline)
const EXEC_SQL_RE = /EXEC\s+SQL([\s\S]*?)END-EXEC/gi;

// EXEC CICS ... END-EXEC
const EXEC_CICS_RE = /EXEC\s+CICS/i;

// SECTION names: "XXXX SECTION."
const SECTION_RE = /^\s{0,8}(\S[\w-]+)\s+SECTION\s*\./gim;

// File Descriptor: FD XXXX
const FD_RE = /^\s*FD\s+(\S+)/gim;

// SQL table extraction from SELECT/INSERT/UPDATE/DELETE
function extractTablesFromSQL(sqlBody: string): Array<{ name: string; op: 'reads' | 'writes' }> {
  const results: Array<{ name: string; op: 'reads' | 'writes' }> = [];

  // SELECT ... FROM table
  const selectRe = /\bFROM\s+(\w+)/gi;
  let m: RegExpExecArray | null;
  while ((m = selectRe.exec(sqlBody)) !== null) {
    results.push({ name: m[1]!.toUpperCase(), op: 'reads' });
  }

  // Also JOIN ... ON
  const joinRe = /\bJOIN\s+(\w+)/gi;
  while ((m = joinRe.exec(sqlBody)) !== null) {
    results.push({ name: m[1]!.toUpperCase(), op: 'reads' });
  }

  // INSERT INTO table
  const insertRe = /\bINSERT\s+INTO\s+(\w+)/gi;
  while ((m = insertRe.exec(sqlBody)) !== null) {
    results.push({ name: m[1]!.toUpperCase(), op: 'writes' });
  }

  // UPDATE table
  const updateRe = /\bUPDATE\s+(\w+)/gi;
  while ((m = updateRe.exec(sqlBody)) !== null) {
    results.push({ name: m[1]!.toUpperCase(), op: 'writes' });
  }

  // DELETE FROM table
  const deleteRe = /\bDELETE\s+FROM\s+(\w+)/gi;
  while ((m = deleteRe.exec(sqlBody)) !== null) {
    results.push({ name: m[1]!.toUpperCase(), op: 'writes' });
  }

  return results;
}

export class CobolAnalyzer implements AnalyzerPlugin {
  name = 'cobol';
  languages = ['cobol'];
  extensions = ['.cbl', '.cob', '.cpy', '.CBL', '.COB', '.CPY'];

  analyzeFile(content: string, relPath: string, _rootDir: string): FileAnalysis {
    const nodes: IntelNode[] = [];
    const edges: IntelEdge[] = [];

    const fileId = `file:${relPath}`;

    // Detect CICS
    const hasCics = EXEC_CICS_RE.test(content);
    const fileFramework = hasCics ? 'cics' : undefined;

    // Extract PROGRAM-ID
    const programIdMatch = PROGRAM_ID_RE.exec(content);
    const programName = programIdMatch ? programIdMatch[1]! : relPath;

    // ── 1. File node ──────────────────────────────────────────────────────
    const fileNode: IntelNode = {
      id: fileId,
      type: 'file',
      name: programName,
      filePath: relPath,
      language: 'cobol',
      metadata: { programId: programName },
    };
    if (fileFramework) fileNode.framework = fileFramework;
    nodes.push(fileNode);

    // ── 2. COPY → import edges ────────────────────────────────────────────
    const copyPattern = new RegExp(COPY_RE.source, COPY_RE.flags);
    let copyMatch: RegExpExecArray | null;
    while ((copyMatch = copyPattern.exec(content)) !== null) {
      const copybook = copyMatch[1]!;
      const targetId = `file:${copybook}`;
      edges.push({ source: fileId, target: targetId, type: 'imports' });
    }

    // ── 3. CALL → calls edges ─────────────────────────────────────────────
    const callPattern = new RegExp(CALL_RE.source, CALL_RE.flags);
    let callMatch: RegExpExecArray | null;
    while ((callMatch = callPattern.exec(content)) !== null) {
      const callee = callMatch[1]!;
      const targetId = `file:${callee}`;
      edges.push({ source: fileId, target: targetId, type: 'calls' });
    }

    // ── 4. EXEC SQL → table nodes + read/write edges ──────────────────────
    const sqlPattern = new RegExp(EXEC_SQL_RE.source, EXEC_SQL_RE.flags);
    let sqlMatch: RegExpExecArray | null;
    const seenTables = new Set<string>();
    while ((sqlMatch = sqlPattern.exec(content)) !== null) {
      const sqlBody = sqlMatch[1]!;
      const tableMentions = extractTablesFromSQL(sqlBody);
      for (const { name, op } of tableMentions) {
        if (!seenTables.has(name)) {
          seenTables.add(name);
          nodes.push({
            id: `table:${name}`,
            type: 'table',
            name,
            filePath: relPath,
            metadata: {},
          });
        }
        edges.push({ source: fileId, target: `table:${name}`, type: op });
      }
    }

    // ── 5. SECTION nodes ──────────────────────────────────────────────────
    const sectionPattern = new RegExp(SECTION_RE.source, SECTION_RE.flags);
    let sectionMatch: RegExpExecArray | null;
    const seenSections = new Set<string>();
    while ((sectionMatch = sectionPattern.exec(content)) !== null) {
      const sectionName = sectionMatch[1]!;
      // Skip COBOL division names
      if (['IDENTIFICATION', 'ENVIRONMENT', 'DATA', 'PROCEDURE', 'FILE', 'WORKING-STORAGE', 'LOCAL-STORAGE', 'LINKAGE'].includes(sectionName.toUpperCase())) continue;
      if (seenSections.has(sectionName)) continue;
      seenSections.add(sectionName);

      const sectionId = `function:${sectionName}`;
      nodes.push({
        id: sectionId,
        type: 'function',
        name: sectionName,
        filePath: relPath,
        language: 'cobol',
        metadata: { sectionType: 'SECTION' },
      });
      edges.push({ source: fileId, target: sectionId, type: 'contains' });
    }

    // ── 6. FD → external nodes ────────────────────────────────────────────
    const fdPattern = new RegExp(FD_RE.source, FD_RE.flags);
    let fdMatch: RegExpExecArray | null;
    const seenFds = new Set<string>();
    while ((fdMatch = fdPattern.exec(content)) !== null) {
      const fdName = fdMatch[1]!.replace(/\.$/, '');
      if (seenFds.has(fdName)) continue;
      seenFds.add(fdName);

      const fdId = `external:${fdName}`;
      nodes.push({
        id: fdId,
        type: 'external',
        name: fdName,
        filePath: relPath,
        language: 'cobol',
        metadata: { fdType: 'file-descriptor' },
      });
      edges.push({ source: fileId, target: fdId, type: 'contains' });
    }

    return { nodes, edges };
  }
}
