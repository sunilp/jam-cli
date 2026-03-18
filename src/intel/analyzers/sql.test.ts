import { describe, it, expect } from 'vitest';
import { SqlAnalyzer } from './sql.js';

const analyzer = new SqlAnalyzer();

// ── Metadata ───────────────────────────────────────────────────────────────

describe('SqlAnalyzer — metadata', () => {
  it('has correct name, language, and extensions', () => {
    expect(analyzer.name).toBe('sql');
    expect(analyzer.languages).toContain('sql');
    expect(analyzer.extensions).toContain('.sql');
  });
});

// ── File node ──────────────────────────────────────────────────────────────

describe('SqlAnalyzer — file node', () => {
  it('creates a file node with language=sql', () => {
    const { nodes } = analyzer.analyzeFile('SELECT 1;', 'db/schema.sql', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode!.id).toBe('file:db/schema.sql');
    expect(fileNode!.language).toBe('sql');
    expect(fileNode!.filePath).toBe('db/schema.sql');
  });

  it('adds dbtLayer=staging for models/staging/ path', () => {
    const { nodes } = analyzer.analyzeFile('SELECT 1;', 'models/staging/stg_orders.sql', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.metadata['dbtLayer']).toBe('staging');
  });

  it('adds dbtLayer=mart for models/marts/ path', () => {
    const { nodes } = analyzer.analyzeFile('SELECT 1;', 'models/marts/dim_customers.sql', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.metadata['dbtLayer']).toBe('mart');
  });

  it('does not add dbtLayer for regular paths', () => {
    const { nodes } = analyzer.analyzeFile('SELECT 1;', 'db/queries.sql', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.metadata['dbtLayer']).toBeUndefined();
  });
});

// ── CREATE TABLE ───────────────────────────────────────────────────────────

describe('SqlAnalyzer — CREATE TABLE', () => {
  it('creates a table node for CREATE TABLE', () => {
    const code = `CREATE TABLE users (\n  id INT PRIMARY KEY,\n  name VARCHAR(100)\n);`;
    const { nodes } = analyzer.analyzeFile(code, 'schema.sql', '/root');
    const tableNode = nodes.find(n => n.type === 'table' && n.name === 'users');
    expect(tableNode).toBeDefined();
    expect(tableNode!.id).toBe('table:users');
    expect(tableNode!.language).toBe('sql');
  });

  it('extracts column names from CREATE TABLE', () => {
    const code = `CREATE TABLE orders (\n  order_id INT,\n  customer_id INT,\n  total DECIMAL(10,2)\n);`;
    const { nodes } = analyzer.analyzeFile(code, 'schema.sql', '/root');
    const tableNode = nodes.find(n => n.type === 'table' && n.name === 'orders');
    expect(tableNode!.metadata['columns']).toEqual(
      expect.arrayContaining(['order_id', 'customer_id', 'total'])
    );
  });

  it('handles CREATE TABLE IF NOT EXISTS', () => {
    const code = `CREATE TABLE IF NOT EXISTS products (id INT);`;
    const { nodes } = analyzer.analyzeFile(code, 'schema.sql', '/root');
    const tableNode = nodes.find(n => n.type === 'table' && n.name === 'products');
    expect(tableNode).toBeDefined();
  });

  it('creates contains edge from file to table', () => {
    const code = `CREATE TABLE invoices (id INT);`;
    const { edges } = analyzer.analyzeFile(code, 'schema.sql', '/root');
    const containsEdge = edges.find(e => e.type === 'contains' && e.target === 'table:invoices');
    expect(containsEdge).toBeDefined();
  });
});

// ── ALTER TABLE ────────────────────────────────────────────────────────────

describe('SqlAnalyzer — ALTER TABLE', () => {
  it('creates depends-on edge for ALTER TABLE', () => {
    const code = `ALTER TABLE users ADD COLUMN email VARCHAR(255);`;
    const { edges } = analyzer.analyzeFile(code, 'migration.sql', '/root');
    const edge = edges.find(e => e.type === 'depends-on' && e.target === 'table:users');
    expect(edge).toBeDefined();
    expect(edge!.source).toBe('file:migration.sql');
  });
});

// ── FOREIGN KEY REFERENCES ─────────────────────────────────────────────────

describe('SqlAnalyzer — FOREIGN KEY detection', () => {
  it('creates depends-on edge between tables for FOREIGN KEY REFERENCES', () => {
    const code = `
CREATE TABLE orders (
  id INT,
  user_id INT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);`;
    const { edges } = analyzer.analyzeFile(code, 'schema.sql', '/root');
    const fkEdge = edges.find(e => e.type === 'depends-on' && e.source === 'table:orders' && e.target === 'table:users');
    expect(fkEdge).toBeDefined();
  });
});

// ── INSERT / SELECT ────────────────────────────────────────────────────────

describe('SqlAnalyzer — INSERT and SELECT', () => {
  it('creates writes edge for INSERT INTO', () => {
    const code = `INSERT INTO audit_log (event, ts) VALUES ('login', NOW());`;
    const { edges } = analyzer.analyzeFile(code, 'queries.sql', '/root');
    const edge = edges.find(e => e.type === 'writes' && e.target === 'table:audit_log');
    expect(edge).toBeDefined();
  });

  it('creates reads edge for SELECT ... FROM', () => {
    const code = `SELECT id, name FROM customers WHERE active = 1;`;
    const { edges } = analyzer.analyzeFile(code, 'queries.sql', '/root');
    const edge = edges.find(e => e.type === 'reads' && e.target === 'table:customers');
    expect(edge).toBeDefined();
  });
});

// ── dbt ────────────────────────────────────────────────────────────────────

describe('SqlAnalyzer — dbt ref() and source()', () => {
  it('creates depends-on edge for dbt ref()', () => {
    const code = `SELECT * FROM {{ ref('stg_orders') }}`;
    const { edges } = analyzer.analyzeFile(code, 'models/marts/orders.sql', '/root');
    const edge = edges.find(e => e.type === 'depends-on' && e.target === 'file:stg_orders.sql');
    expect(edge).toBeDefined();
    expect(edge!.source).toBe('file:models/marts/orders.sql');
  });

  it('creates reads edge for dbt source()', () => {
    const code = `SELECT * FROM {{ source('raw', 'orders') }}`;
    const { edges } = analyzer.analyzeFile(code, 'models/staging/stg_orders.sql', '/root');
    const edge = edges.find(e => e.type === 'reads' && e.target === 'table:raw.orders');
    expect(edge).toBeDefined();
  });

  it('handles multiple dbt refs in one file', () => {
    const code = `
SELECT o.id, c.name
FROM {{ ref('stg_orders') }} o
JOIN {{ ref('stg_customers') }} c ON o.customer_id = c.id
`;
    const { edges } = analyzer.analyzeFile(code, 'models/marts/summary.sql', '/root');
    const dbtEdges = edges.filter(e => e.type === 'depends-on');
    expect(dbtEdges).toHaveLength(2);
  });
});
