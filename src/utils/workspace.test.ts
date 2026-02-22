import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { findGitRoot, getWorkspaceRoot, isGitRepo } from './workspace.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'jam-workspace-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('findGitRoot', () => {
  it('returns the directory that directly contains .git', async () => {
    await mkdir(join(tmpDir, '.git'));
    const result = await findGitRoot(tmpDir);
    expect(result).toBe(tmpDir);
  });

  it('walks up parent directories to find .git', async () => {
    await mkdir(join(tmpDir, '.git'));
    const subDir = join(tmpDir, 'a', 'b', 'c');
    await mkdir(subDir, { recursive: true });
    const result = await findGitRoot(subDir);
    expect(result).toBe(tmpDir);
  });

  it('falls back to startDir when no .git is found', async () => {
    const subDir = join(tmpDir, 'noGitHere');
    await mkdir(subDir);
    const result = await findGitRoot(subDir);
    expect(result).toBe(subDir);
  });

  it('returns startDir immediately when it contains .git', async () => {
    const repoDir = join(tmpDir, 'myrepo');
    await mkdir(join(repoDir, '.git'), { recursive: true });
    const result = await findGitRoot(repoDir);
    expect(result).toBe(repoDir);
  });

  it('finds .git even when nested deeply', async () => {
    await mkdir(join(tmpDir, '.git'));
    const deep = join(tmpDir, 'src', 'features', 'auth', 'tests');
    await mkdir(deep, { recursive: true });
    const result = await findGitRoot(deep);
    expect(result).toBe(tmpDir);
  });
});

describe('getWorkspaceRoot', () => {
  it('returns git root when inside a git repo', async () => {
    await mkdir(join(tmpDir, '.git'));
    const subDir = join(tmpDir, 'src');
    await mkdir(subDir);
    const result = await getWorkspaceRoot(subDir);
    expect(result).toBe(tmpDir);
  });

  it('returns cwd when not in a git repo', async () => {
    const result = await getWorkspaceRoot(tmpDir);
    expect(result).toBe(tmpDir);
  });
});

describe('isGitRepo', () => {
  it('returns true for a directory with .git', async () => {
    await mkdir(join(tmpDir, '.git'));
    const result = await isGitRepo(tmpDir);
    expect(result).toBe(true);
  });

  it('returns true for a subdirectory of a git repo', async () => {
    await mkdir(join(tmpDir, '.git'));
    const sub = join(tmpDir, 'src');
    await mkdir(sub);
    const result = await isGitRepo(sub);
    expect(result).toBe(true);
  });

  it('returns false for a directory without .git', async () => {
    const result = await isGitRepo(tmpDir);
    expect(result).toBe(false);
  });
});
