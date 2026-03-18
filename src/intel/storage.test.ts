// src/intel/storage.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IntelGraph } from './graph.js';
import {
  saveGraph,
  loadGraph,
  saveEnrichment,
  loadEnrichment,
  saveMermaid,
  checkGitignore,
} from './storage.js';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'jam-storage-test-'));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeGraph(): IntelGraph {
  const g = new IntelGraph();
  g.addNode({ id: 'file:src/index.ts', type: 'file', name: 'src/index.ts', filePath: 'src/index.ts', metadata: {} });
  g.addNode({ id: 'function:main', type: 'function', name: 'main', metadata: {} });
  g.addEdge({ source: 'file:src/index.ts', target: 'function:main', type: 'contains' });
  g.frameworks = ['express'];
  g.languages = ['typescript'];
  g.mtimes = { 'src/index.ts': 1234567890 };
  return g;
}

describe('saveGraph / loadGraph', () => {
  it('saves graph and file exists', async () => {
    const dir = join(tmpDir, 'save-test');
    const g = makeGraph();
    await saveGraph(g, dir);

    const content = await readFile(join(dir, '.jam', 'intel', 'graph.json'), 'utf-8');
    expect(content).toBeTruthy();
    const parsed = JSON.parse(content);
    expect(parsed.version).toBe(1);
    expect(parsed.nodes.length).toBe(2);
  });

  it('loads graph roundtrip', async () => {
    const dir = join(tmpDir, 'roundtrip-test');
    const g = makeGraph();
    await saveGraph(g, dir);

    const loaded = await loadGraph(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.nodeCount).toBe(2);
    expect(loaded!.edgeCount).toBe(1);
    expect(loaded!.frameworks).toContain('express');
    expect(loaded!.languages).toContain('typescript');
    expect(loaded!.mtimes['src/index.ts']).toBe(1234567890);
  });

  it('returns null when no graph file exists', async () => {
    const dir = join(tmpDir, 'no-graph');
    const result = await loadGraph(dir);
    expect(result).toBeNull();
  });
});

describe('saveEnrichment / loadEnrichment', () => {
  it('saves and loads enrichment', async () => {
    const dir = join(tmpDir, 'enrichment-test');
    const entries = [
      {
        nodeId: 'file:src/index.ts',
        purpose: 'Entry point',
        domain: 'server',
        depth: 'shallow' as const,
      },
    ];
    await saveEnrichment(entries, { depth: 'shallow', tokensUsed: 150 }, dir);

    const loaded = await loadEnrichment(dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.depth).toBe('shallow');
    expect(loaded!.tokensUsed).toBe(150);
    expect(loaded!.entries.length).toBe(1);
    expect(loaded!.entries[0]!.nodeId).toBe('file:src/index.ts');
    expect(loaded!.entries[0]!.purpose).toBe('Entry point');
  });

  it('returns null when no enrichment file exists', async () => {
    const dir = join(tmpDir, 'no-enrichment');
    const result = await loadEnrichment(dir);
    expect(result).toBeNull();
  });
});

describe('saveMermaid', () => {
  it('saves mermaid to default filename and returns path', async () => {
    const dir = join(tmpDir, 'mermaid-test');
    const mmd = 'graph TD\n  A --> B';
    const resultPath = await saveMermaid(mmd, dir);

    expect(resultPath).toBe(join(dir, '.jam', 'intel', 'architecture.mmd'));
    const content = await readFile(resultPath, 'utf-8');
    expect(content).toBe(mmd);
  });

  it('saves mermaid with custom filename', async () => {
    const dir = join(tmpDir, 'mermaid-custom-test');
    const mmd = 'graph LR\n  X --> Y';
    const resultPath = await saveMermaid(mmd, dir, 'custom.mmd');

    expect(resultPath).toBe(join(dir, '.jam', 'intel', 'custom.mmd'));
    const content = await readFile(resultPath, 'utf-8');
    expect(content).toBe(mmd);
  });
});

describe('checkGitignore', () => {
  it('returns false when .gitignore does not exist', async () => {
    const dir = join(tmpDir, 'no-gitignore');
    expect(checkGitignore(dir)).toBe(false);
  });

  it('returns false when .jam is not in .gitignore', async () => {
    const dir = join(tmpDir, 'gitignore-no-jam');
    await writeFile(join(dir + '-dummy-hack', '.gitignore').replace('-dummy-hack', ''), 'node_modules\ndist\n').catch(async () => {
      // dir may not exist yet, create it
      const { mkdir: mkdirFs } = await import('node:fs/promises');
      await mkdirFs(dir, { recursive: true });
      await writeFile(join(dir, '.gitignore'), 'node_modules\ndist\n');
    });
    try {
      await writeFile(join(dir, '.gitignore'), 'node_modules\ndist\n');
    } catch {
      // already exists from above
    }
    expect(checkGitignore(dir)).toBe(false);
  });

  it('returns true when .jam is in .gitignore', async () => {
    const dir = join(tmpDir, 'gitignore-has-jam');
    const { mkdir: mkdirFs } = await import('node:fs/promises');
    await mkdirFs(dir, { recursive: true });
    await writeFile(join(dir, '.gitignore'), 'node_modules\n.jam\ndist\n');
    expect(checkGitignore(dir)).toBe(true);
  });

  it('returns true when .jam/intel is in .gitignore', async () => {
    const dir = join(tmpDir, 'gitignore-has-jam-intel');
    const { mkdir: mkdirFs } = await import('node:fs/promises');
    await mkdirFs(dir, { recursive: true });
    await writeFile(join(dir, '.gitignore'), 'node_modules\n.jam/intel\n');
    expect(checkGitignore(dir)).toBe(true);
  });
});

describe('lock prevents concurrent writes', () => {
  it('raises an error on concurrent writes (second write finds lock)', async () => {
    const dir = join(tmpDir, 'lock-test');
    const g = makeGraph();

    // Manually create the lock first
    const { mkdir: mkdirFs, writeFile: wf } = await import('node:fs/promises');
    await mkdirFs(join(dir, '.jam', 'intel'), { recursive: true });
    await wf(join(dir, '.jam', 'intel', '.lock'), 'fake-lock', { flag: 'wx' });

    // Now try to save — should fail because lock exists
    await expect(saveGraph(g, dir)).rejects.toThrow();
  });
});
