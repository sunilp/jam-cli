// src/trace/extractors/sql.test.ts
import { describe, it, expect } from 'vitest';
import type Parser from 'tree-sitter';
import { isTreeSitterAvailable, parseSource } from '../parser.js';
import './sql.js'; // registers SqlExtractor
import { getExtractor } from './base.js';

/** Parse SQL source and run the extractor. */
async function extract(source: string) {
  // SqlExtractor works via regex, so it doesn't strictly require tree-sitter.
  // We still call parseSource so the extract() signature receives a real (or
  // minimal) rootNode.  If tree-sitter is unavailable we construct a stub.
  let rootNode: Parser.SyntaxNode;

  const tree = isTreeSitterAvailable() ? await parseSource(source, 'sql') : null;
  if (tree) {
    rootNode = tree.rootNode;
  } else {
    // Minimal stub so the extractor can run in regex-only mode
    rootNode = {
      type: 'program',
      childCount: 0,
      child: () => null,
      children: [],
      parent: null,
      text: source,
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: 0 },
    } as unknown as Parser.SyntaxNode;
  }

  const extractor = getExtractor('sql');
  if (!extractor) throw new Error('SqlExtractor not registered');
  return extractor.extract(rootNode, source);
}

describe('SqlExtractor', () => {
  describe('registration', () => {
    it('is registered under "sql"', () => {
      const ext = getExtractor('sql');
      expect(ext).toBeDefined();
      expect(ext!.language).toBe('sql');
    });
  });

  // ── Symbols ────────────────────────────────────────────────────────────────

  describe('CREATE PROCEDURE → symbol', () => {
    it('extracts a stored procedure', async () => {
      const source = `
        CREATE PROCEDURE GetAllUsers()
        BEGIN
          SELECT * FROM users;
        END;
      `;
      const result = await extract(source);
      const sym = result.symbols.find(s => s.name === 'GetAllUsers');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('procedure');
    });

    it('extracts CREATE OR REPLACE PROCEDURE', async () => {
      const source = `CREATE OR REPLACE PROCEDURE usp_UpdateOrder() BEGIN END;`;
      const result = await extract(source);
      const sym = result.symbols.find(s => s.name === 'usp_UpdateOrder');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('procedure');
    });

    it('records the correct line number', async () => {
      const source = [
        '-- header comment',
        'CREATE PROCEDURE MyProc()',
        'BEGIN',
        '  SELECT 1;',
        'END;',
      ].join('\n');
      const result = await extract(source);
      const sym = result.symbols.find(s => s.name === 'MyProc');
      expect(sym).toBeDefined();
      expect(sym!.line).toBe(2);
    });
  });

  describe('CREATE FUNCTION → symbol', () => {
    it('extracts a user-defined function', async () => {
      const source = `CREATE FUNCTION CalculateTax(amount DECIMAL) RETURNS DECIMAL BEGIN RETURN amount * 0.1; END;`;
      const result = await extract(source);
      const sym = result.symbols.find(s => s.name === 'CalculateTax');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('function');
    });
  });

  describe('CREATE VIEW → symbol', () => {
    it('extracts a view', async () => {
      const source = `CREATE VIEW ActiveUsers AS SELECT * FROM users WHERE active = 1;`;
      const result = await extract(source);
      const sym = result.symbols.find(s => s.name === 'ActiveUsers');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('view');
    });

    it('extracts CREATE OR REPLACE VIEW', async () => {
      const source = `CREATE OR REPLACE VIEW RecentOrders AS SELECT * FROM orders WHERE created_at > NOW();`;
      const result = await extract(source);
      const sym = result.symbols.find(s => s.name === 'RecentOrders');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('view');
    });
  });

  describe('CREATE TRIGGER → symbol', () => {
    it('extracts a trigger', async () => {
      const source = `CREATE TRIGGER after_insert_order AFTER INSERT ON orders FOR EACH ROW BEGIN END;`;
      const result = await extract(source);
      const sym = result.symbols.find(s => s.name === 'after_insert_order');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('trigger');
    });
  });

  describe('multiple symbols', () => {
    it('extracts multiple CREATE objects from one file', async () => {
      const source = [
        'CREATE PROCEDURE GetUser() BEGIN SELECT * FROM users; END;',
        'CREATE FUNCTION GetCount() RETURNS INT BEGIN RETURN 0; END;',
        'CREATE VIEW UserSummary AS SELECT id, name FROM users;',
      ].join('\n');
      const result = await extract(source);
      const names = result.symbols.map(s => s.name);
      expect(names).toContain('GetUser');
      expect(names).toContain('GetCount');
      expect(names).toContain('UserSummary');
    });
  });

  // ── Calls ──────────────────────────────────────────────────────────────────

  describe('CALL → cross-language call', () => {
    it('extracts CALL statement', async () => {
      const source = `CALL GetAllUsers();`;
      const result = await extract(source);
      const call = result.calls.find(c => c.calleeName === 'GetAllUsers');
      expect(call).toBeDefined();
      expect(call!.kind).toBe('cross-language');
    });

    it('extracts multiple CALL statements', async () => {
      const source = [
        'CALL ValidateOrder(123);',
        'CALL SendNotification(456);',
      ].join('\n');
      const result = await extract(source);
      const callees = result.calls.map(c => c.calleeName);
      expect(callees).toContain('ValidateOrder');
      expect(callees).toContain('SendNotification');
    });
  });

  describe('EXEC / EXECUTE → cross-language call', () => {
    it('extracts EXEC statement', async () => {
      const source = `EXEC usp_GetUsers;`;
      const result = await extract(source);
      const call = result.calls.find(c => c.calleeName === 'usp_GetUsers');
      expect(call).toBeDefined();
      expect(call!.kind).toBe('cross-language');
    });

    it('extracts EXECUTE statement', async () => {
      const source = `EXECUTE sp_RunReport;`;
      const result = await extract(source);
      const call = result.calls.find(c => c.calleeName === 'sp_RunReport');
      expect(call).toBeDefined();
      expect(call!.kind).toBe('cross-language');
    });

    it('records the correct line for EXEC', async () => {
      const source = [
        '-- setup',
        'EXEC usp_Init;',
      ].join('\n');
      const result = await extract(source);
      const call = result.calls.find(c => c.calleeName === 'usp_Init');
      expect(call).toBeDefined();
      expect(call!.line).toBe(2);
    });
  });

  // ── Column references ──────────────────────────────────────────────────────

  describe('SELECT column references', () => {
    it('extracts columns from SELECT … FROM', async () => {
      const source = `SELECT user_id, email, created_at FROM users;`;
      const result = await extract(source);
      const cols = result.columns.filter(c => c.tableName === 'users' && c.operation === 'SELECT');
      const colNames = cols.map(c => c.columnName);
      expect(colNames).toContain('user_id');
      expect(colNames).toContain('email');
      expect(colNames).toContain('created_at');
    });

    it('emits wildcard for SELECT *', async () => {
      const source = `SELECT * FROM products;`;
      const result = await extract(source);
      const col = result.columns.find(c => c.tableName === 'products' && c.operation === 'SELECT');
      expect(col).toBeDefined();
      expect(col!.columnName).toBe('*');
    });
  });

  describe('UPDATE column references', () => {
    it('extracts columns from UPDATE … SET', async () => {
      const source = `UPDATE orders SET status = 'shipped', updated_at = NOW() WHERE id = 1;`;
      const result = await extract(source);
      const cols = result.columns.filter(c => c.tableName === 'orders' && c.operation === 'UPDATE');
      const colNames = cols.map(c => c.columnName);
      expect(colNames).toContain('status');
      expect(colNames).toContain('updated_at');
    });

    it('extracts a single column from a simple UPDATE', async () => {
      const source = `UPDATE users SET email = 'new@example.com' WHERE id = 42;`;
      const result = await extract(source);
      const col = result.columns.find(c => c.tableName === 'users' && c.operation === 'UPDATE');
      expect(col).toBeDefined();
      expect(col!.columnName).toBe('email');
    });
  });

  describe('INSERT column references', () => {
    it('extracts columns from INSERT INTO … (cols)', async () => {
      const source = `INSERT INTO users (name, email, role) VALUES ('Alice', 'a@b.com', 'admin');`;
      const result = await extract(source);
      const cols = result.columns.filter(c => c.tableName === 'users' && c.operation === 'INSERT');
      const colNames = cols.map(c => c.columnName);
      expect(colNames).toContain('name');
      expect(colNames).toContain('email');
      expect(colNames).toContain('role');
    });
  });

  describe('DELETE column references', () => {
    it('emits wildcard for DELETE FROM', async () => {
      const source = `DELETE FROM sessions WHERE expired = 1;`;
      const result = await extract(source);
      const col = result.columns.find(c => c.tableName === 'sessions' && c.operation === 'DELETE');
      expect(col).toBeDefined();
      expect(col!.columnName).toBe('*');
    });
  });

  // ── Combined / realistic scenarios ────────────────────────────────────────

  describe('combined extraction', () => {
    it('extracts symbols, calls, and columns from a realistic stored procedure', async () => {
      const source = [
        'CREATE PROCEDURE ProcessOrders()',
        'BEGIN',
        '  SELECT order_id, total FROM orders WHERE status = "pending";',
        '  UPDATE orders SET status = "processing" WHERE status = "pending";',
        '  CALL NotifyShipping();',
        'END;',
      ].join('\n');

      const result = await extract(source);

      // Symbol
      const sym = result.symbols.find(s => s.name === 'ProcessOrders');
      expect(sym).toBeDefined();
      expect(sym!.kind).toBe('procedure');

      // Call
      const call = result.calls.find(c => c.calleeName === 'NotifyShipping');
      expect(call).toBeDefined();
      expect(call!.kind).toBe('cross-language');

      // SELECT columns
      const selectCols = result.columns.filter(c => c.operation === 'SELECT' && c.tableName === 'orders');
      expect(selectCols.map(c => c.columnName)).toContain('order_id');
      expect(selectCols.map(c => c.columnName)).toContain('total');

      // UPDATE columns
      const updateCols = result.columns.filter(c => c.operation === 'UPDATE' && c.tableName === 'orders');
      expect(updateCols.map(c => c.columnName)).toContain('status');
    });

    it('extracts from a migration file with multiple DDL statements', async () => {
      const source = [
        'CREATE VIEW CustomerOrders AS',
        '  SELECT c.id, c.name, o.total FROM customers c JOIN orders o ON c.id = o.customer_id;',
        '',
        'CREATE TRIGGER update_timestamp BEFORE UPDATE ON products',
        '  FOR EACH ROW SET NEW.updated_at = NOW();',
        '',
        'INSERT INTO audit_log (action, table_name) VALUES ("migrate", "products");',
      ].join('\n');

      const result = await extract(source);

      const viewSym = result.symbols.find(s => s.name === 'CustomerOrders');
      expect(viewSym).toBeDefined();
      expect(viewSym!.kind).toBe('view');

      const trigSym = result.symbols.find(s => s.name === 'update_timestamp');
      expect(trigSym).toBeDefined();
      expect(trigSym!.kind).toBe('trigger');

      const insertCols = result.columns.filter(c => c.operation === 'INSERT' && c.tableName === 'audit_log');
      expect(insertCols.map(c => c.columnName)).toContain('action');
      expect(insertCols.map(c => c.columnName)).toContain('table_name');
    });
  });

  // ── Empty / edge cases ────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns empty arrays for empty source', async () => {
      const result = await extract('');
      expect(result.symbols).toHaveLength(0);
      expect(result.calls).toHaveLength(0);
      expect(result.columns).toHaveLength(0);
      expect(result.imports).toHaveLength(0);
    });

    it('returns empty arrays for plain SELECT with no CREATE', async () => {
      const result = await extract('SELECT 1;');
      expect(result.symbols).toHaveLength(0);
    });

    it('always returns empty imports array', async () => {
      const source = `CREATE PROCEDURE Foo() BEGIN END;`;
      const result = await extract(source);
      expect(result.imports).toHaveLength(0);
    });
  });
});
