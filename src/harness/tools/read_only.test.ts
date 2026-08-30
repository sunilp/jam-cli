import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileTool } from './read_file.js';
import { listDirTool } from './list_dir.js';
import { searchTextTool } from './search_text.js';
import { gitDiffTool } from './git_diff.js';
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

  it('returns sandbox.denied rather than throwing when the file is unreadable', async () => {
    await chmod(join(root, 'a.txt'), 0o000);
    try {
      const r = await readFileTool.execute({ path: 'a.txt' }, ctx);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.type).toBe('sandbox.denied');
    } finally {
      await chmod(join(root, 'a.txt'), 0o644);
    }
  });
});

describe('list_dir', () => {
  it('lists entries', async () => {
    const r = await listDirTool.execute({ path: '.' }, ctx);
    expect(r.ok && r.value.entries.map((e) => e.name).sort()).toEqual(['a.txt', 'sub']);
  });

  it('returns sandbox.denied rather than throwing when the directory is unreadable', async () => {
    await chmod(join(root, 'sub'), 0o000);
    try {
      const r = await listDirTool.execute({ path: 'sub' }, ctx);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.type).toBe('sandbox.denied');
    } finally {
      await chmod(join(root, 'sub'), 0o755);
    }
  });
});

describe('git_diff', () => {
  it('returns a structured error outside a git repo rather than throwing', async () => {
    const r = await gitDiffTool.execute({}, ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.type).toBe('internal');
  });

  it('stores the full diff as an artifact and only previews it to the model', async () => {
    const world = new LocalExecutionWorld();
    const git = async (args: string[]): Promise<void> => {
      const r = await world.subprocess.run({ command: 'git', args, cwd: root, timeoutMs: 15_000 });
      if (r.exitCode !== 0) throw new Error(r.stderr);
    };
    await git(['init', '-q']);
    await git(['config', 'user.email', 't@example.com']);
    await git(['config', 'user.name', 'T']);
    await git(['add', '-A']);
    await git(['commit', '-qm', 'init']);

    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    await writeFile(join(root, 'a.txt'), `${big}\n`);

    const r = await gitDiffTool.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifact).toBeDefined();
    expect(r.value.diff).toContain('lines elided');
    expect(ctx.artifacts.get(r.artifact!.digest)).toContain('line 399');
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
