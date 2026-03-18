import { describe, it, expect } from 'vitest';
import { CobolAnalyzer } from './cobol.js';

const analyzer = new CobolAnalyzer();

// ── Metadata ───────────────────────────────────────────────────────────────

describe('CobolAnalyzer — metadata', () => {
  it('has correct name, language, and extensions', () => {
    expect(analyzer.name).toBe('cobol');
    expect(analyzer.languages).toContain('cobol');
    expect(analyzer.extensions).toContain('.cbl');
    expect(analyzer.extensions).toContain('.cob');
    expect(analyzer.extensions).toContain('.cpy');
    expect(analyzer.extensions).toContain('.CBL');
    expect(analyzer.extensions).toContain('.COB');
    expect(analyzer.extensions).toContain('.CPY');
  });
});

// ── File node ──────────────────────────────────────────────────────────────

describe('CobolAnalyzer — file node', () => {
  it('creates a file node with language=cobol', () => {
    const code = `       IDENTIFICATION DIVISION.\n       PROGRAM-ID. MYPROG.`;
    const { nodes } = analyzer.analyzeFile(code, 'src/MYPROG.cbl', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode!.language).toBe('cobol');
    expect(fileNode!.filePath).toBe('src/MYPROG.cbl');
  });

  it('uses PROGRAM-ID as program name in file node', () => {
    const code = `       PROGRAM-ID. PAYROLL.`;
    const { nodes } = analyzer.analyzeFile(code, 'PAYROLL.cbl', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.name).toBe('PAYROLL');
    expect(fileNode!.metadata['programId']).toBe('PAYROLL');
  });

  it('falls back to relPath as name when PROGRAM-ID absent', () => {
    const { nodes } = analyzer.analyzeFile('* no program id', 'UTIL.cpy', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.name).toBe('UTIL.cpy');
  });
});

// ── COPY → import edges ────────────────────────────────────────────────────

describe('CobolAnalyzer — COPY (copybook) detection', () => {
  it('creates import edge for COPY statement', () => {
    const code = `       COPY CUSTDATA.`;
    const { edges } = analyzer.analyzeFile(code, 'MAIN.cbl', '/root');
    const importEdge = edges.find(e => e.type === 'imports');
    expect(importEdge).toBeDefined();
    expect(importEdge!.source).toBe('file:MAIN.cbl');
    expect(importEdge!.target).toBe('file:CUSTDATA.');
  });

  it('handles multiple COPY statements', () => {
    const code = `       COPY CUSTDATA.\n       COPY PRODTBL.`;
    const { edges } = analyzer.analyzeFile(code, 'MAIN.cbl', '/root');
    const importEdges = edges.filter(e => e.type === 'imports');
    expect(importEdges).toHaveLength(2);
  });
});

// ── CALL → calls edges ─────────────────────────────────────────────────────

describe('CobolAnalyzer — CALL detection', () => {
  it('creates calls edge for CALL statement', () => {
    const code = `           CALL 'SUBPROG' USING WS-INPUT.`;
    const { edges } = analyzer.analyzeFile(code, 'MAIN.cbl', '/root');
    const callEdge = edges.find(e => e.type === 'calls');
    expect(callEdge).toBeDefined();
    expect(callEdge!.source).toBe('file:MAIN.cbl');
    expect(callEdge!.target).toBe('file:SUBPROG');
  });

  it('handles CALL with double quotes', () => {
    const code = `           CALL "UTILITY" USING DATA-AREA.`;
    const { edges } = analyzer.analyzeFile(code, 'MAIN.cbl', '/root');
    const callEdge = edges.find(e => e.type === 'calls');
    expect(callEdge).toBeDefined();
    expect(callEdge!.target).toBe('file:UTILITY');
  });
});

// ── EXEC SQL ───────────────────────────────────────────────────────────────

describe('CobolAnalyzer — EXEC SQL table detection', () => {
  it('extracts table from SELECT ... FROM as reads edge', () => {
    const code = `           EXEC SQL\n               SELECT * FROM CUSTOMERS\n           END-EXEC.`;
    const { nodes, edges } = analyzer.analyzeFile(code, 'REPORT.cbl', '/root');
    const tableNode = nodes.find(n => n.type === 'table' && n.name === 'CUSTOMERS');
    expect(tableNode).toBeDefined();
    const readsEdge = edges.find(e => e.type === 'reads' && e.target === 'table:CUSTOMERS');
    expect(readsEdge).toBeDefined();
  });

  it('extracts table from INSERT INTO as writes edge', () => {
    const code = `           EXEC SQL\n               INSERT INTO ORDERS (ID, AMOUNT) VALUES (:WS-ID, :WS-AMT)\n           END-EXEC.`;
    const { nodes, edges } = analyzer.analyzeFile(code, 'ORDER.cbl', '/root');
    const tableNode = nodes.find(n => n.type === 'table' && n.name === 'ORDERS');
    expect(tableNode).toBeDefined();
    const writesEdge = edges.find(e => e.type === 'writes' && e.target === 'table:ORDERS');
    expect(writesEdge).toBeDefined();
  });

  it('extracts table from UPDATE as writes edge', () => {
    const code = `           EXEC SQL\n               UPDATE ACCOUNTS SET BALANCE = :WS-BAL WHERE ID = :WS-ID\n           END-EXEC.`;
    const { edges } = analyzer.analyzeFile(code, 'UPDATE.cbl', '/root');
    const writesEdge = edges.find(e => e.type === 'writes' && e.target === 'table:ACCOUNTS');
    expect(writesEdge).toBeDefined();
  });

  it('extracts table from DELETE FROM as writes edge', () => {
    const code = `           EXEC SQL\n               DELETE FROM TEMP_DATA WHERE FLAG = 'Y'\n           END-EXEC.`;
    const { edges } = analyzer.analyzeFile(code, 'CLEAN.cbl', '/root');
    const writesEdge = edges.find(e => e.type === 'writes' && e.target === 'table:TEMP_DATA');
    expect(writesEdge).toBeDefined();
  });
});

// ── EXEC CICS ─────────────────────────────────────────────────────────────

describe('CobolAnalyzer — EXEC CICS detection', () => {
  it('marks file framework as cics when EXEC CICS is present', () => {
    const code = `           EXEC CICS SEND TEXT FROM(WS-MSG) END-EXEC.`;
    const { nodes } = analyzer.analyzeFile(code, 'SCREEN.cbl', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.framework).toBe('cics');
  });

  it('does not set cics framework when absent', () => {
    const code = `       PROGRAM-ID. BATCH.`;
    const { nodes } = analyzer.analyzeFile(code, 'BATCH.cbl', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.framework).toBeUndefined();
  });
});

// ── SECTION nodes ──────────────────────────────────────────────────────────

describe('CobolAnalyzer — SECTION detection', () => {
  it('creates function nodes for SECTION paragraphs', () => {
    const code = `       PROCEDURE DIVISION.\n       INIT-SECTION SECTION.\n           MOVE 0 TO WS-COUNT.`;
    const { nodes } = analyzer.analyzeFile(code, 'PROG.cbl', '/root');
    const section = nodes.find(n => n.type === 'function' && n.name === 'INIT-SECTION');
    expect(section).toBeDefined();
    expect(section!.language).toBe('cobol');
  });

  it('skips standard COBOL division names as sections', () => {
    const code = `       PROCEDURE DIVISION.\n       DATA SECTION.`;
    const { nodes } = analyzer.analyzeFile(code, 'PROG.cbl', '/root');
    const dataSection = nodes.find(n => n.type === 'function' && n.name === 'DATA');
    expect(dataSection).toBeUndefined();
  });
});

// ── FD → external nodes ────────────────────────────────────────────────────

describe('CobolAnalyzer — FD (file descriptor) detection', () => {
  it('creates external node for FD declaration', () => {
    const code = `       FILE SECTION.\n       FD CUSTOMER-FILE.`;
    const { nodes } = analyzer.analyzeFile(code, 'REPORT.cbl', '/root');
    const extNode = nodes.find(n => n.type === 'external' && n.name === 'CUSTOMER-FILE');
    expect(extNode).toBeDefined();
    expect(extNode!.metadata['fdType']).toBe('file-descriptor');
  });
});

// ── Combined scenario ──────────────────────────────────────────────────────

describe('CobolAnalyzer — combined scenario', () => {
  it('handles a realistic COBOL program', () => {
    const code = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. BILLING.

       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT INVOICE-FILE ASSIGN TO 'INVOICES.DAT'.

       DATA DIVISION.
       FILE SECTION.
       FD INVOICE-FILE.

       WORKING-STORAGE SECTION.

       PROCEDURE DIVISION.
       MAIN-SECTION SECTION.
           COPY CUSTDATA.
           CALL 'TAXCALC' USING WS-AMOUNT.
           EXEC SQL
               SELECT * FROM INVOICES WHERE CUST_ID = :WS-ID
           END-EXEC
           EXEC SQL
               INSERT INTO BILLING_LOG (ID, AMT) VALUES (:WS-ID, :WS-AMT)
           END-EXEC
           EXEC CICS RETURN END-EXEC.
    `;
    const { nodes, edges } = analyzer.analyzeFile(code, 'BILLING.cbl', '/root');

    // File node with program name
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.name).toBe('BILLING');
    expect(fileNode!.framework).toBe('cics');

    // FD node
    expect(nodes.find(n => n.type === 'external' && n.name === 'INVOICE-FILE')).toBeDefined();

    // Section node
    expect(nodes.find(n => n.type === 'function' && n.name === 'MAIN-SECTION')).toBeDefined();

    // COPY edge
    expect(edges.find(e => e.type === 'imports' && e.target === 'file:CUSTDATA.')).toBeDefined();

    // CALL edge
    expect(edges.find(e => e.type === 'calls' && e.target === 'file:TAXCALC')).toBeDefined();

    // SQL table nodes and edges
    expect(nodes.find(n => n.type === 'table' && n.name === 'INVOICES')).toBeDefined();
    expect(nodes.find(n => n.type === 'table' && n.name === 'BILLING_LOG')).toBeDefined();
    expect(edges.find(e => e.type === 'reads' && e.target === 'table:INVOICES')).toBeDefined();
    expect(edges.find(e => e.type === 'writes' && e.target === 'table:BILLING_LOG')).toBeDefined();
  });
});
