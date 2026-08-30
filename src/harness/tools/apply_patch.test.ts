import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPatchTool } from './apply_patch.js';
import { LocalExecutionWorld } from '../world/local.js';
import { ArtifactStore } from '../artifacts.js';
import type { ToolContext } from './types.js';

const world = new LocalExecutionWorld();
let root: string;
let ctx: ToolContext;

async function git(args: string[]): Promise<void> {
  const r = await world.subprocess.run({ command: 'git', args, cwd: root, timeoutMs: 15_000 });
  if (r.exitCode !== 0) throw new Error(r.stderr);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jam-patch-'));
  await git(['init', '-q']);
  await git(['config', 'user.email', 't@example.com']);
  await git(['config', 'user.name', 'T']);
  await writeFile(join(root, 'a.txt'), 'one\n');
  await git(['add', '.']);
  await git(['commit', '-qm', 'init']);
  ctx = {
    world, workspaceRoot: root, signal: new AbortController().signal,
    emit: () => {}, artifacts: new ArtifactStore(':memory:'), callId: 'c1',
  };
});

const GOOD = `--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-one
+ONE
`;

const CONFLICTING = `--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-nonexistent line
+replacement
`;

describe('apply_patch', () => {
  it('applies a valid patch and reports changed files', async () => {
    const r = await applyPatchTool.execute({ patch: GOOD }, ctx);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.changedFiles).toEqual(['a.txt']);
    expect(await readFile(join(root, 'a.txt'), 'utf-8')).toBe('ONE\n');
  });

  it('returns patch.conflict as recoverable and leaves the tree untouched', async () => {
    const r = await applyPatchTool.execute({ patch: CONFLICTING }, ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.type).toBe('patch.conflict');
    expect(!r.ok && r.error.recoverable).toBe(true);
    expect(await readFile(join(root, 'a.txt'), 'utf-8')).toBe('one\n');
  });

  it('rejects an empty patch as invalid_input', async () => {
    const r = await applyPatchTool.execute({ patch: '   ' }, ctx);
    expect(!r.ok && r.error.type).toBe('invalid_input');
  });

  it('emits file.modified for a binary change, which numstat reports as dashes', async () => {
    await writeFile(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    await git(['add', 'blob.bin']);
    await git(['commit', '-qm', 'add binary']);
    await writeFile(join(root, 'blob.bin'), Buffer.from([9, 9, 9, 0, 1]));
    const patch = await (async (): Promise<string> => {
      const r = await world.subprocess.run({
        command: 'git', args: ['diff', '--binary'], cwd: root, timeoutMs: 15_000,
      });
      return r.stdout;
    })();
    await git(['checkout', '--', 'blob.bin']);

    const events: string[] = [];
    const r = await applyPatchTool.execute({ patch }, {
      ...ctx, emit: (e) => { if (e.type === 'file.modified') events.push(e.path); },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.changedFiles).toEqual(['blob.bin']);
    expect(events).toEqual(['blob.bin']);
  });

  it('emits file.modified for each changed file', async () => {
    const events: string[] = [];
    await applyPatchTool.execute({ patch: GOOD }, {
      ...ctx, emit: (e) => { if (e.type === 'file.modified') events.push(e.path); },
    });
    expect(events).toEqual(['a.txt']);
  });
});
