import { describe, it, expect } from 'vitest';
import { OpenApiAnalyzer } from './openapi.js';

const analyzer = new OpenApiAnalyzer();

// ── Metadata ───────────────────────────────────────────────────────────────

describe('OpenApiAnalyzer — metadata', () => {
  it('has correct name, language, and extensions', () => {
    expect(analyzer.name).toBe('openapi');
    expect(analyzer.languages).toContain('openapi');
    expect(analyzer.extensions).toContain('.yaml');
    expect(analyzer.extensions).toContain('.yml');
  });
});

// ── Guard: non-OpenAPI YAML files should return empty ──────────────────────

describe('OpenApiAnalyzer — guard clause', () => {
  it('returns empty analysis for plain YAML without openapi/swagger key', () => {
    const code = `name: my-project\nversion: 1.0.0\nconfig:\n  port: 3000\n`;
    const { nodes, edges } = analyzer.analyzeFile(code, 'config.yml', '/root');
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it('analyzes file with openapi: key in first 10 lines', () => {
    const code = `openapi: '3.0.0'\ninfo:\n  title: Test\n`;
    const { nodes } = analyzer.analyzeFile(code, 'api.yml', '/root');
    expect(nodes.length).toBeGreaterThan(0);
  });

  it('analyzes file with swagger: key (Swagger 2.0)', () => {
    const code = `swagger: '2.0'\ninfo:\n  title: Test\n`;
    const { nodes } = analyzer.analyzeFile(code, 'api.yaml', '/root');
    expect(nodes.length).toBeGreaterThan(0);
  });
});

// ── File node ──────────────────────────────────────────────────────────────

describe('OpenApiAnalyzer — file node', () => {
  it('creates a file node with language=openapi', () => {
    const code = `openapi: '3.0.0'\ninfo:\n  title: Test\n`;
    const { nodes } = analyzer.analyzeFile(code, 'api/openapi.yaml', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode!.id).toBe('file:api/openapi.yaml');
    expect(fileNode!.language).toBe('openapi');
  });
});

// ── Endpoints from paths: ──────────────────────────────────────────────────

describe('OpenApiAnalyzer — endpoint detection', () => {
  const oa3Spec = `
openapi: '3.0.0'
info:
  title: Users API
  version: '1.0'
paths:
  /users:
    get:
      summary: List users
      responses:
        '200':
          description: OK
    post:
      summary: Create user
      responses:
        '201':
          description: Created
  /users/{id}:
    get:
      summary: Get user
    put:
      summary: Update user
    delete:
      summary: Delete user
`;

  it('creates endpoint nodes from paths: block', () => {
    const { nodes } = analyzer.analyzeFile(oa3Spec, 'api.yaml', '/root');
    const endpoints = nodes.filter(n => n.type === 'endpoint');
    expect(endpoints.length).toBeGreaterThanOrEqual(4);
  });

  it('endpoint node has correct name format METHOD /path', () => {
    const { nodes } = analyzer.analyzeFile(oa3Spec, 'api.yaml', '/root');
    const getUsers = nodes.find(n => n.type === 'endpoint' && n.name === 'GET /users');
    expect(getUsers).toBeDefined();
    expect(getUsers!.id).toBe('endpoint:GET /users');
  });

  it('detects POST endpoint', () => {
    const { nodes } = analyzer.analyzeFile(oa3Spec, 'api.yaml', '/root');
    const post = nodes.find(n => n.type === 'endpoint' && n.name === 'POST /users');
    expect(post).toBeDefined();
  });

  it('detects DELETE endpoint', () => {
    const { nodes } = analyzer.analyzeFile(oa3Spec, 'api.yaml', '/root');
    const del = nodes.find(n => n.type === 'endpoint' && n.name === 'DELETE /users/{id}');
    expect(del).toBeDefined();
  });

  it('sets language=openapi on endpoint nodes', () => {
    const { nodes } = analyzer.analyzeFile(oa3Spec, 'api.yaml', '/root');
    const endpoint = nodes.find(n => n.type === 'endpoint');
    expect(endpoint!.language).toBe('openapi');
  });

  it('creates contains edges from file to endpoints', () => {
    const { edges } = analyzer.analyzeFile(oa3Spec, 'api.yaml', '/root');
    const containsEdge = edges.find(e => e.type === 'contains' && e.target === 'endpoint:GET /users');
    expect(containsEdge).toBeDefined();
    expect(containsEdge!.source).toBe('file:api.yaml');
  });
});

// ── Components/definitions schemas ─────────────────────────────────────────

describe('OpenApiAnalyzer — schema detection', () => {
  const oa3WithSchemas = `
openapi: '3.0.0'
info:
  title: API
paths:
  /users:
    get:
      summary: List
components:
  schemas:
    User:
      type: object
      properties:
        id:
          type: string
        address:
          $ref: '#/components/schemas/Address'
    Address:
      type: object
      properties:
        street:
          type: string
`;

  it('creates schema nodes from components/schemas', () => {
    const { nodes } = analyzer.analyzeFile(oa3WithSchemas, 'api.yaml', '/root');
    const schemas = nodes.filter(n => n.type === 'schema');
    expect(schemas.length).toBeGreaterThanOrEqual(2);
    expect(schemas.map(s => s.name)).toContain('User');
    expect(schemas.map(s => s.name)).toContain('Address');
  });

  it('creates depends-on edges for $ref between schemas', () => {
    const { edges } = analyzer.analyzeFile(oa3WithSchemas, 'api.yaml', '/root');
    const refEdge = edges.find(
      e => e.type === 'depends-on' && e.source === 'schema:User' && e.target === 'schema:Address'
    );
    expect(refEdge).toBeDefined();
  });
});

// ── Swagger 2.0 definitions ────────────────────────────────────────────────

describe('OpenApiAnalyzer — Swagger 2.0 definitions', () => {
  const swagger2 = `
swagger: '2.0'
info:
  title: Legacy API
  version: '1.0'
paths:
  /items:
    get:
      summary: List items
definitions:
  Item:
    type: object
    properties:
      id:
        type: integer
`;

  it('creates schema nodes from definitions: block', () => {
    const { nodes } = analyzer.analyzeFile(swagger2, 'swagger.yaml', '/root');
    const schema = nodes.find(n => n.type === 'schema' && n.name === 'Item');
    expect(schema).toBeDefined();
  });

  it('creates endpoint from swagger 2.0 paths', () => {
    const { nodes } = analyzer.analyzeFile(swagger2, 'swagger.yaml', '/root');
    const endpoint = nodes.find(n => n.type === 'endpoint' && n.name === 'GET /items');
    expect(endpoint).toBeDefined();
  });
});
