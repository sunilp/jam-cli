import { describe, it, expect } from 'vitest';
import { TypeScriptAnalyzer } from './typescript.js';

const analyzer = new TypeScriptAnalyzer();

describe('TypeScriptAnalyzer — metadata', () => {
  it('has correct name and extensions', () => {
    expect(analyzer.name).toBe('typescript');
    expect(analyzer.extensions).toContain('.ts');
    expect(analyzer.extensions).toContain('.tsx');
    expect(analyzer.extensions).toContain('.js');
    expect(analyzer.extensions).toContain('.jsx');
    expect(analyzer.extensions).toContain('.mjs');
    expect(analyzer.extensions).toContain('.cjs');
    expect(analyzer.languages).toContain('typescript');
    expect(analyzer.languages).toContain('javascript');
  });
});

// ── File node ──────────────────────────────────────────────────────────────

describe('TypeScriptAnalyzer — file node', () => {
  it('creates a file node with language=typescript for .ts files', () => {
    const { nodes } = analyzer.analyzeFile('const x = 1;', 'src/index.ts', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode!.id).toBe('file:src/index.ts');
    expect(fileNode!.language).toBe('typescript');
    expect(fileNode!.filePath).toBe('src/index.ts');
  });

  it('creates a file node with language=typescript for .tsx files', () => {
    const { nodes } = analyzer.analyzeFile('', 'src/App.tsx', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.language).toBe('typescript');
  });

  it('creates a file node with language=javascript for .js files', () => {
    const { nodes } = analyzer.analyzeFile('const x = 1;', 'src/util.js', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.language).toBe('javascript');
  });

  it('creates a file node with language=javascript for .mjs files', () => {
    const { nodes } = analyzer.analyzeFile('', 'src/worker.mjs', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.language).toBe('javascript');
  });

  it('creates a file node with language=javascript for .cjs files', () => {
    const { nodes } = analyzer.analyzeFile('', 'src/legacy.cjs', '/root');
    const fileNode = nodes.find(n => n.type === 'file');
    expect(fileNode!.language).toBe('javascript');
  });
});

// ── Exported symbols ───────────────────────────────────────────────────────

describe('TypeScriptAnalyzer — exported function nodes', () => {
  it('extracts exported function as function node', () => {
    const code = `export function handleRequest(req, res) {}`;
    const { nodes } = analyzer.analyzeFile(code, 'src/handler.ts', '/root');
    const fn = nodes.find(n => n.type === 'function' && n.name === 'handleRequest');
    expect(fn).toBeDefined();
    expect(fn!.id).toBe('function:handleRequest');
    expect(fn!.filePath).toBe('src/handler.ts');
  });

  it('extracts exported async function', () => {
    const code = `export async function fetchData() {}`;
    const { nodes } = analyzer.analyzeFile(code, 'src/api.ts', '/root');
    const fn = nodes.find(n => n.type === 'function' && n.name === 'fetchData');
    expect(fn).toBeDefined();
  });

  it('extracts exported default function', () => {
    const code = `export default function App() { return null; }`;
    const { nodes } = analyzer.analyzeFile(code, 'src/App.tsx', '/root');
    const fn = nodes.find(n => n.type === 'function' && n.name === 'App');
    expect(fn).toBeDefined();
  });

  it('extracts exported const as function node', () => {
    const code = `export const myUtil = () => {};`;
    const { nodes } = analyzer.analyzeFile(code, 'src/utils.ts', '/root');
    const fn = nodes.find(n => n.type === 'function' && n.name === 'myUtil');
    expect(fn).toBeDefined();
  });

  it('extracts exported enum as function node', () => {
    const code = `export enum Status { Active, Inactive }`;
    const { nodes } = analyzer.analyzeFile(code, 'src/types.ts', '/root');
    const fn = nodes.find(n => n.type === 'function' && n.name === 'Status');
    expect(fn).toBeDefined();
  });

  it('ignores non-exported functions', () => {
    const code = `function internalHelper() {}`;
    const { nodes } = analyzer.analyzeFile(code, 'src/util.ts', '/root');
    const fn = nodes.find(n => n.type === 'function');
    expect(fn).toBeUndefined();
  });
});

describe('TypeScriptAnalyzer — exported class nodes', () => {
  it('extracts exported class as class node', () => {
    const code = `export class UserService {}`;
    const { nodes } = analyzer.analyzeFile(code, 'src/services/user.ts', '/root');
    const cls = nodes.find(n => n.type === 'class' && n.name === 'UserService');
    expect(cls).toBeDefined();
    expect(cls!.id).toBe('class:UserService');
    expect(cls!.filePath).toBe('src/services/user.ts');
  });

  it('extracts exported interface as class node', () => {
    const code = `export interface UserDto { id: string; }`;
    const { nodes } = analyzer.analyzeFile(code, 'src/dto.ts', '/root');
    const cls = nodes.find(n => n.type === 'class' && n.name === 'UserDto');
    expect(cls).toBeDefined();
  });

  it('extracts exported type alias as class node', () => {
    const code = `export type UserId = string;`;
    const { nodes } = analyzer.analyzeFile(code, 'src/types.ts', '/root');
    const cls = nodes.find(n => n.type === 'class' && n.name === 'UserId');
    expect(cls).toBeDefined();
  });

  it('extracts multiple classes from a file', () => {
    const code = `
export class Foo {}
export class Bar {}
`;
    const { nodes } = analyzer.analyzeFile(code, 'src/models.ts', '/root');
    const classes = nodes.filter(n => n.type === 'class');
    expect(classes).toHaveLength(2);
    expect(classes.map(c => c.name)).toContain('Foo');
    expect(classes.map(c => c.name)).toContain('Bar');
  });
});

// ── Contains edges ─────────────────────────────────────────────────────────

describe('TypeScriptAnalyzer — contains edges', () => {
  it('creates contains edges from file to its symbols', () => {
    const code = `
export class MyService {}
export function doWork() {}
`;
    const { edges } = analyzer.analyzeFile(code, 'src/service.ts', '/root');
    const containsEdges = edges.filter(e => e.type === 'contains');
    expect(containsEdges.some(e => e.source === 'file:src/service.ts' && e.target === 'class:MyService')).toBe(true);
    expect(containsEdges.some(e => e.source === 'file:src/service.ts' && e.target === 'function:doWork')).toBe(true);
  });
});

// ── Import edges ───────────────────────────────────────────────────────────

describe('TypeScriptAnalyzer — import edges', () => {
  it('extracts ESM import as imports edge', () => {
    const code = `import { foo } from './foo.js';`;
    const { edges } = analyzer.analyzeFile(code, 'src/index.ts', '/root');
    const importEdge = edges.find(e => e.type === 'imports');
    expect(importEdge).toBeDefined();
    expect(importEdge!.source).toBe('file:src/index.ts');
  });

  it('resolves .js extension to .ts for import target', () => {
    const code = `import { foo } from './foo.js';`;
    const { edges } = analyzer.analyzeFile(code, 'src/index.ts', '/root');
    const importEdge = edges.find(e => e.type === 'imports');
    expect(importEdge!.target).toBe('file:src/foo.ts');
  });

  it('extracts relative import without extension', () => {
    const code = `import { bar } from './utils';`;
    const { edges } = analyzer.analyzeFile(code, 'src/index.ts', '/root');
    const importEdge = edges.find(e => e.type === 'imports');
    expect(importEdge).toBeDefined();
    expect(importEdge!.target).toBe('file:src/utils.ts');
  });

  it('extracts require() as imports edge', () => {
    const code = `const x = require('./helper');`;
    const { edges } = analyzer.analyzeFile(code, 'src/legacy.js', '/root');
    const importEdge = edges.find(e => e.type === 'imports');
    expect(importEdge).toBeDefined();
    expect(importEdge!.source).toBe('file:src/legacy.js');
  });

  it('extracts dynamic import() as imports edge', () => {
    const code = `const mod = import('./dynamic.js');`;
    const { edges } = analyzer.analyzeFile(code, 'src/loader.ts', '/root');
    const importEdge = edges.find(e => e.type === 'imports');
    expect(importEdge).toBeDefined();
  });

  it('ignores non-relative imports (node_modules)', () => {
    const code = `import chalk from 'chalk';\nimport { join } from 'node:path';`;
    const { edges } = analyzer.analyzeFile(code, 'src/cli.ts', '/root');
    const importEdges = edges.filter(e => e.type === 'imports');
    expect(importEdges).toHaveLength(0);
  });

  it('handles import from subdirectory', () => {
    const code = `import { UserService } from './services/user.js';`;
    const { edges } = analyzer.analyzeFile(code, 'src/index.ts', '/root');
    const importEdge = edges.find(e => e.type === 'imports');
    expect(importEdge!.target).toBe('file:src/services/user.ts');
  });
});

// ── Express routes ─────────────────────────────────────────────────────────

describe('TypeScriptAnalyzer — Express route detection', () => {
  it('detects app.get route as endpoint node', () => {
    const code = `app.get('/users', handler);`;
    const { nodes } = analyzer.analyzeFile(code, 'src/routes.ts', '/root');
    const endpoint = nodes.find(n => n.type === 'endpoint');
    expect(endpoint).toBeDefined();
    expect(endpoint!.name).toBe('GET /users');
    expect(endpoint!.framework).toBe('express');
    expect(endpoint!.id).toBe('endpoint:GET /users');
  });

  it('detects app.post route', () => {
    const code = `app.post('/users', createUser);`;
    const { nodes } = analyzer.analyzeFile(code, 'src/routes.ts', '/root');
    const endpoint = nodes.find(n => n.type === 'endpoint');
    expect(endpoint!.name).toBe('POST /users');
  });

  it('detects router.put route', () => {
    const code = `router.put('/users/:id', updateUser);`;
    const { nodes } = analyzer.analyzeFile(code, 'src/routes.ts', '/root');
    const endpoint = nodes.find(n => n.type === 'endpoint');
    expect(endpoint!.name).toBe('PUT /users/:id');
  });

  it('detects router.delete route', () => {
    const code = `router.delete('/users/:id', deleteUser);`;
    const { nodes } = analyzer.analyzeFile(code, 'src/routes.ts', '/root');
    const endpoint = nodes.find(n => n.type === 'endpoint');
    expect(endpoint!.name).toBe('DELETE /users/:id');
  });

  it('detects router.patch route', () => {
    const code = `router.patch('/items/:id', patchItem);`;
    const { nodes } = analyzer.analyzeFile(code, 'src/routes.ts', '/root');
    const endpoint = nodes.find(n => n.type === 'endpoint');
    expect(endpoint!.name).toBe('PATCH /items/:id');
  });

  it('detects multiple routes in one file', () => {
    const code = `
app.get('/users', listUsers);
app.post('/users', createUser);
app.delete('/users/:id', deleteUser);
`;
    const { nodes } = analyzer.analyzeFile(code, 'src/routes.ts', '/root');
    const endpoints = nodes.filter(n => n.type === 'endpoint');
    expect(endpoints).toHaveLength(3);
    expect(endpoints.map(e => e.name)).toContain('GET /users');
    expect(endpoints.map(e => e.name)).toContain('POST /users');
    expect(endpoints.map(e => e.name)).toContain('DELETE /users/:id');
  });

  it('sets filePath on endpoint node', () => {
    const code = `app.get('/health', check);`;
    const { nodes } = analyzer.analyzeFile(code, 'src/routes.ts', '/root');
    const endpoint = nodes.find(n => n.type === 'endpoint');
    expect(endpoint!.filePath).toBe('src/routes.ts');
  });
});

// ── React components ───────────────────────────────────────────────────────

describe('TypeScriptAnalyzer — React component detection', () => {
  it('marks exported function in .tsx file with framework=react', () => {
    const code = `export function Button({ label }: Props) { return <span>{label}</span>; }`;
    const { nodes } = analyzer.analyzeFile(code, 'src/components/Button.tsx', '/root');
    const fn = nodes.find(n => n.type === 'function' && n.name === 'Button');
    expect(fn).toBeDefined();
    expect(fn!.framework).toBe('react');
  });

  it('marks exported default function in .tsx file with framework=react', () => {
    const code = `export default function App() { return <div/>; }`;
    const { nodes } = analyzer.analyzeFile(code, 'src/App.tsx', '/root');
    const fn = nodes.find(n => n.type === 'function' && n.name === 'App');
    expect(fn!.framework).toBe('react');
  });

  it('does NOT set framework=react for .ts files even with function exports', () => {
    const code = `export function processData() {}`;
    const { nodes } = analyzer.analyzeFile(code, 'src/processor.ts', '/root');
    const fn = nodes.find(n => n.type === 'function' && n.name === 'processData');
    expect(fn!.framework).toBeUndefined();
  });

  it('does NOT set framework=react for .jsx files (only .tsx)', () => {
    const code = `export function Widget() { return null; }`;
    const { nodes } = analyzer.analyzeFile(code, 'src/Widget.jsx', '/root');
    const fn = nodes.find(n => n.type === 'function' && n.name === 'Widget');
    // .jsx is treated as javascript so no react framework tagging
    expect(fn!.framework).toBeUndefined();
  });
});

// ── Config / process.env ───────────────────────────────────────────────────

describe('TypeScriptAnalyzer — process.env detection', () => {
  it('detects process.env.PORT as config node', () => {
    const code = `const port = process.env.PORT ?? 3000;`;
    const { nodes } = analyzer.analyzeFile(code, 'src/server.ts', '/root');
    const cfg = nodes.find(n => n.type === 'config' && n.name === 'PORT');
    expect(cfg).toBeDefined();
    expect(cfg!.id).toBe('config:PORT');
    expect(cfg!.filePath).toBe('src/server.ts');
  });

  it('detects multiple env vars', () => {
    const code = `
const db = process.env.DATABASE_URL;
const secret = process.env.JWT_SECRET;
const port = process.env.PORT;
`;
    const { nodes } = analyzer.analyzeFile(code, 'src/config.ts', '/root');
    const cfgNodes = nodes.filter(n => n.type === 'config');
    expect(cfgNodes).toHaveLength(3);
    const names = cfgNodes.map(c => c.name);
    expect(names).toContain('DATABASE_URL');
    expect(names).toContain('JWT_SECRET');
    expect(names).toContain('PORT');
  });

  it('deduplicates repeated env var references', () => {
    const code = `
const a = process.env.API_KEY;
const b = process.env.API_KEY || 'default';
`;
    const { nodes } = analyzer.analyzeFile(code, 'src/client.ts', '/root');
    const cfgNodes = nodes.filter(n => n.type === 'config' && n.name === 'API_KEY');
    expect(cfgNodes).toHaveLength(1);
  });

  it('returns empty config nodes when no process.env usage', () => {
    const code = `export function add(a: number, b: number) { return a + b; }`;
    const { nodes } = analyzer.analyzeFile(code, 'src/math.ts', '/root');
    const cfgNodes = nodes.filter(n => n.type === 'config');
    expect(cfgNodes).toHaveLength(0);
  });
});

// ── Combined scenario ──────────────────────────────────────────────────────

describe('TypeScriptAnalyzer — combined scenario', () => {
  it('handles a realistic Express route file', () => {
    const code = `
import { Router } from 'express';
import { UserService } from './services/user.js';

const router = Router();

export class UserController {
  constructor(private svc: UserService) {}
}

router.get('/users', async (req, res) => {
  const port = process.env.PORT;
  res.json([]);
});

router.post('/users', async (req, res) => {
  res.status(201).json({});
});

export default router;
`;
    const { nodes, edges } = analyzer.analyzeFile(code, 'src/routes/users.ts', '/root');

    // File node
    expect(nodes.find(n => n.id === 'file:src/routes/users.ts')).toBeDefined();

    // Class node
    expect(nodes.find(n => n.type === 'class' && n.name === 'UserController')).toBeDefined();

    // Endpoint nodes
    const endpoints = nodes.filter(n => n.type === 'endpoint');
    expect(endpoints).toHaveLength(2);

    // Config node
    expect(nodes.find(n => n.type === 'config' && n.name === 'PORT')).toBeDefined();

    // Import edge (only relative imports)
    const importEdges = edges.filter(e => e.type === 'imports');
    expect(importEdges).toHaveLength(1);
    expect(importEdges[0]!.target).toBe('file:src/routes/services/user.ts');

    // Contains edges
    const containsEdges = edges.filter(e => e.type === 'contains');
    expect(containsEdges.some(e => e.target === 'class:UserController')).toBe(true);
  });
});
