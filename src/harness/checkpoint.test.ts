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

  it('reports files it could not remove instead of claiming a full rollback', async () => {
    const store = new CheckpointStore(world, root);
    const cp = await store.create('before edit');

    await writeFile(join(root, 'a.txt'), 'modified\n');
    await writeFile(join(root, 'new.txt'), 'created by the agent\n');
    await git(['add', 'new.txt']);

    const result = await store.restore(cp.id);

    expect(await readFile(join(root, 'a.txt'), 'utf-8')).toBe('original\n');
    expect(result.reverted).toContain('a.txt');
    expect(result.notRemoved).toEqual(['new.txt']);
  });

  it('lists checkpoints newest first', async () => {
    const store = new CheckpointStore(world, root);
    const one = await store.create('one');
    await writeFile(join(root, 'a.txt'), 'x\n');
    const two = await store.create('two');
    const ids = (await store.list()).map((c) => c.id);
    expect(ids.slice(0, 2)).toEqual([two.id, one.id]);
  });

  it('restores by id alone, without depending on in-memory meta -- the ' +
     'shape a fresh process resuming from the journal is in', async () => {
    const creator = new CheckpointStore(world, root);
    const cp = await creator.create('before edit');
    await writeFile(join(root, 'a.txt'), 'modified\n');

    // A brand-new store instance, as a fresh process reading the checkpoint
    // id out of the journal would be: its `meta` Map has never seen this id.
    const resumed = new CheckpointStore(world, root);
    const result = await resumed.restore(cp.id);

    expect(await readFile(join(root, 'a.txt'), 'utf-8')).toBe('original\n');
    expect(result.reverted).toContain('a.txt');
  });

  it('throws a clear error restoring an id with no matching ref', async () => {
    const store = new CheckpointStore(world, root);
    await expect(store.restore('not-a-real-checkpoint-id'))
      .rejects.toThrow(/Unknown checkpoint: not-a-real-checkpoint-id/);
  });

  it('prune deletes every ref this store created and reports the count', async () => {
    const store = new CheckpointStore(world, root);
    const one = await store.create('one');
    await writeFile(join(root, 'a.txt'), 'x\n');
    const two = await store.create('two');

    const pruned = await store.prune();
    expect(pruned).toBe(2);
    expect(await store.list()).toEqual([]);

    // The refs themselves are gone from git, not just forgotten by meta.
    for (const cp of [one, two]) {
      const r = await world.subprocess.run({
        command: 'git', args: ['show-ref', '--verify', '--quiet', cp.ref],
        cwd: root, timeoutMs: 10_000,
      });
      expect(r.exitCode).not.toBe(0);
    }
  });

  it('prune is a harmless no-op when nothing was created', async () => {
    const store = new CheckpointStore(world, root);
    expect(await store.prune()).toBe(0);
  });
});
