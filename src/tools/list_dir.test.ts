import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { listDirTool } from './list_dir.js';
import type { ToolContext } from './types.js';

let tmpDir: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'jam-list-test-'));
  ctx = { workspaceRoot: tmpDir, cwd: tmpDir };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('list_dir tool', () => {
  it('returns "(empty directory)" for an empty directory', async () => {
    const result = await listDirTool.execute({ path: '.' }, ctx);
    expect(result.output).toBe('(empty directory)');
  });

  it('lists files and directories, dirs first with trailing slash', async () => {
    await mkdir(join(tmpDir, 'subdir'));
    await writeFile(join(tmpDir, 'a.txt'), '');
    await writeFile(join(tmpDir, 'b.txt'), '');
    const result = await listDirTool.execute({ path: '.' }, ctx);
    const lines = result.output.split('\n');
    expect(lines[0]).toBe('subdir/');
    expect(lines).toContain('a.txt');
    expect(lines).toContain('b.txt');
  });

  it('sorts directories alphabetically before files alphabetically', async () => {
    await mkdir(join(tmpDir, 'beta'));
    await mkdir(join(tmpDir, 'alpha'));
    await writeFile(join(tmpDir, 'z.txt'), '');
    await writeFile(join(tmpDir, 'a.txt'), '');
    const result = await listDirTool.execute({ path: '.' }, ctx);
    const lines = result.output.split('\n');
    expect(lines[0]).toBe('alpha/');
    expect(lines[1]).toBe('beta/');
    expect(lines[2]).toBe('a.txt');
    expect(lines[3]).toBe('z.txt');
  });

  it('defaults path to "." when not provided', async () => {
    await writeFile(join(tmpDir, 'file.txt'), '');
    const result = await listDirTool.execute({}, ctx);
    expect(result.output).toContain('file.txt');
  });

  it('throws INPUT_FILE_NOT_FOUND for a missing directory', async () => {
    await expect(
      listDirTool.execute({ path: 'does-not-exist' }, ctx)
    ).rejects.toMatchObject({ code: 'INPUT_FILE_NOT_FOUND' });
  });

  it('can list a subdirectory', async () => {
    await mkdir(join(tmpDir, 'sub'));
    await writeFile(join(tmpDir, 'sub', 'inner.txt'), '');
    const result = await listDirTool.execute({ path: 'sub' }, ctx);
    expect(result.output).toContain('inner.txt');
    expect(result.output).not.toContain('sub/');
  });

  it('includes correct metadata', async () => {
    await mkdir(join(tmpDir, 'dir1'));
    await writeFile(join(tmpDir, 'file1.txt'), '');
    await writeFile(join(tmpDir, 'file2.txt'), '');
    const result = await listDirTool.execute({ path: '.' }, ctx);
    expect(result.metadata).toMatchObject({
      totalEntries: 3,
      directoryCount: 1,
      fileCount: 2,
    });
  });

  it('includes trailing slash only on directories', async () => {
    await mkdir(join(tmpDir, 'adir'));
    await writeFile(join(tmpDir, 'afile.txt'), '');
    const result = await listDirTool.execute({ path: '.' }, ctx);
    expect(result.output).toContain('adir/');
    expect(result.output).not.toMatch(/afile\.txt\//);
  });
});
