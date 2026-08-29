import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointStore } from './checkpoint.js';
import { LocalExecutionWorld } from './world/local.js';

const world = new LocalExecutionWorld();
let root: string;

async function git(args: string[]): Promise<void> {
  const r = await world.subprocess.run({ command: 'git', args, cwd: root, timeoutMs: 15_000 });
  if (r.exitCode !== 0) throw new Error(r.stderr);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jam-cp-'));
  await git(['init', '-q']);
  await git(['config', 'user.email', 't@example.com']);
  await git(['config', 'user.name', 'T']);
  await writeFile(join(root, 'a.txt'), 'original\n');
  await git(['add', '.']);
  await git(['commit', '-qm', 'init']);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('CheckpointStore', () => {
  it('creates a checkpoint and restores the prior content', async () => {
    const store = new CheckpointStore(world, root);
    const cp = await store.create('before edit');
    await writeFile(join(root, 'a.txt'), 'modified\n');
    await store.restore(cp.id);
    expect(await readFile(join(root, 'a.txt'), 'utf-8')).toBe('original\n');
  });

  it('lists checkpoints newest first', async () => {
    const store = new CheckpointStore(world, root);
    const one = await store.create('one');
    await writeFile(join(root, 'a.txt'), 'x\n');
    const two = await store.create('two');
    const ids = (await store.list()).map((c) => c.id);
    expect(ids.slice(0, 2)).toEqual([two.id, one.id]);
  });
});
