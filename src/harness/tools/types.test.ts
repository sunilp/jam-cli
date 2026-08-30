import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safePath } from './types.js';
import { LocalExecutionWorld } from '../world/local.js';

const world = new LocalExecutionWorld();

describe('safePath', () => {
  it('resolves a path inside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jam-safe-'));
    await writeFile(join(root, 'a.txt'), 'x');
    await expect(safePath(world, root, 'a.txt')).resolves.toBe(join(root, 'a.txt'));
  });

  it('rejects traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jam-safe-'));
    await expect(safePath(world, root, '../../etc/passwd')).rejects.toThrow(/outside the workspace/);
  });

  it('rejects a symlink escaping the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jam-safe-'));
    const outside = await mkdtemp(join(tmpdir(), 'jam-outside-'));
    await writeFile(join(outside, 'secret'), 'nope');
    await symlink(join(outside, 'secret'), join(root, 'link'));
    await expect(safePath(world, root, 'link')).rejects.toThrow(/outside the workspace/);
  });

  it('allows a not-yet-existing path inside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jam-safe-'));
    await expect(safePath(world, root, 'new.txt')).resolves.toBe(join(root, 'new.txt'));
  });

  it('rejects a symlink loop inside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jam-safe-'));
    await symlink(join(root, 'b'), join(root, 'a'));
    await symlink(join(root, 'a'), join(root, 'b'));
    await expect(safePath(world, root, 'a')).rejects.toThrow(/could not be resolved/);
  });
});
