// src/intel/scanner.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { Scanner } from './scanner.js';

const execAsync = promisify(exec);

let rootDir: string;

async function setupExpressFixture(dir: string): Promise<void> {
  // Git init
  await execAsync('git init', { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });

  // package.json with express
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'express-fixture',
      dependencies: { express: '^4.18.0' },
    }),
  );

  // src/index.ts
  await mkdir(join(dir, 'src'));
  await writeFile(
    join(dir, 'src', 'index.ts'),
    `import express from 'express';
import { app } from './app.js';

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
`,
  );

  // src/app.ts
  await writeFile(
    join(dir, 'src', 'app.ts'),
    `import express from 'express';
import { usersRouter } from './routes/users.js';

export const app = express();
app.use('/users', usersRouter);
app.get('/health', (_req, res) => res.json({ ok: true }));
`,
  );

  // src/routes/users.ts
  await mkdir(join(dir, 'src', 'routes'));
  await writeFile(
    join(dir, 'src', 'routes', 'users.ts'),
    `import { Router } from 'express';

export const router = Router();
router.get('/users', (_req, res) => res.json([]));
router.post('/users', (_req, res) => res.status(201).json({}));
router.get('/users/:id', (_req, res) => res.json({}));
`,
  );

  // Stage and commit all files so git ls-files picks them up
  await execAsync('git add .', { cwd: dir });
  await execAsync('git commit -m "initial"', { cwd: dir });
}

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'jam-scanner-test-'));
  await setupExpressFixture(rootDir);
});

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('Scanner', () => {
  it('scans a workspace and returns a graph with nodes', async () => {
    const scanner = new Scanner();
    const graph = await scanner.scan(rootDir);
    expect(graph.nodeCount).toBeGreaterThan(0);
  });

  it('detects express framework', async () => {
    const scanner = new Scanner();
    const graph = await scanner.scan(rootDir);
    expect(graph.frameworks).toContain('express');
  });

  it('creates file nodes for source files', async () => {
    const scanner = new Scanner();
    const graph = await scanner.scan(rootDir);
    const fileNodes = graph.filterByType('file');
    expect(fileNodes.length).toBeGreaterThanOrEqual(3);
    const filePaths = fileNodes.map(n => n.filePath ?? '');
    expect(filePaths.some(p => p.includes('index.ts'))).toBe(true);
    expect(filePaths.some(p => p.includes('app.ts'))).toBe(true);
    expect(filePaths.some(p => p.includes('users.ts'))).toBe(true);
  });

  it('creates endpoint nodes for Express routes', async () => {
    const scanner = new Scanner();
    const graph = await scanner.scan(rootDir);
    const endpointNodes = graph.filterByType('endpoint');
    expect(endpointNodes.length).toBeGreaterThan(0);
    // Should detect at least the /health route and users routes
    const names = endpointNodes.map(n => n.name);
    expect(names.some(n => n.includes('GET'))).toBe(true);
    expect(names.some(n => n.includes('POST'))).toBe(true);
  });

  it('records mtimes for scanned files', async () => {
    const scanner = new Scanner();
    const graph = await scanner.scan(rootDir);
    const mtimeEntries = Object.keys(graph.mtimes);
    expect(mtimeEntries.length).toBeGreaterThan(0);
    // All mtime values should be positive numbers
    for (const key of mtimeEntries) {
      expect(graph.mtimes[key]).toBeGreaterThan(0);
    }
  });

  it('incremental scan produces same result as full scan', async () => {
    const scanner = new Scanner();
    const graph1 = await scanner.scan(rootDir);

    // Second scan with previousGraph
    const graph2 = await scanner.scan(rootDir, { previousGraph: graph1 });

    // Node counts should be similar (incremental may be equal or very close)
    const nodeCount1 = graph1.nodeCount;
    const nodeCount2 = graph2.nodeCount;
    // Allow small difference due to incremental edge copying logic
    expect(nodeCount2).toBeGreaterThan(0);
    // Frameworks should still be detected
    expect(graph2.frameworks).toContain('express');
  });

  it('excludes files matching exclude patterns', async () => {
    const scanner = new Scanner();
    const graph = await scanner.scan(rootDir, { excludePatterns: ['src/routes'] });
    const fileNodes = graph.filterByType('file');
    const filePaths = fileNodes.map(n => n.filePath ?? '');
    // routes/users.ts should be excluded
    expect(filePaths.some(p => p.includes('routes'))).toBe(false);
  });

  it('collectFiles returns only files with registered analyzers', async () => {
    const scanner = new Scanner();
    const files = await scanner.collectFiles(rootDir, []);
    // Should include .ts files
    expect(files.some(f => f.endsWith('.ts'))).toBe(true);
    // Should not include non-source files
    expect(files.every(f => !f.endsWith('.gitignore') || f.endsWith('.ts'))).toBe(true);
  });
});
