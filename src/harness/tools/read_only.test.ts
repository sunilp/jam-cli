import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileTool } from './read_file.js';
import { listDirTool } from './list_dir.js';
import { searchTextTool } from './search_text.js';
import { LocalExecutionWorld } from '../world/local.js';
import { ArtifactStore } from '../artifacts.js';
import type { ToolContext } from './types.js';

let root: string;
let ctx: ToolContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jam-ro-'));
  await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\n');
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'sub', 'b.ts'), 'export const needle = 1;\n');
  ctx = {
    world: new LocalExecutionWorld(),
    workspaceRoot: root,
    signal: new AbortController().signal,
    emit: () => {},
    artifacts: new ArtifactStore(':memory:'),
    callId: 'c1',
  };
});

describe('read_file', () => {
  it('reads a whole file', async () => {
    const r = await readFileTool.execute({ path: 'a.txt' }, ctx);
    expect(r.ok && r.value.content).toBe('one\ntwo\nthree\n');
  });

  it('reads a line range', async () => {
    const r = await readFileTool.execute({ path: 'a.txt', startLine: 2, endLine: 3 }, ctx);
    expect(r.ok && r.value.content).toBe('two\nthree');
  });

  it('returns not_found rather than throwing', async () => {
    const r = await readFileTool.execute({ path: 'missing.txt' }, ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.type).toBe('not_found');
  });

  it('returns sandbox.denied for traversal', async () => {
    const r = await readFileTool.execute({ path: '../../etc/passwd' }, ctx);
    expect(!r.ok && r.error.type).toBe('sandbox.denied');
  });
});

describe('list_dir', () => {
  it('lists entries', async () => {
    const r = await listDirTool.execute({ path: '.' }, ctx);
    expect(r.ok && r.value.entries.map((e) => e.name).sort()).toEqual(['a.txt', 'sub']);
  });
});

describe('search_text', () => {
  it('finds matches with file and line', async () => {
    const r = await searchTextTool.execute({ query: 'needle' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.matches[0]).toMatchObject({ path: 'sub/b.ts', line: 1 });
  });

  it('returns an empty list rather than an error when nothing matches', async () => {
    const r = await searchTextTool.execute({ query: 'zzzznope' }, ctx);
    expect(r.ok && r.value.matches).toEqual([]);
  });
});
