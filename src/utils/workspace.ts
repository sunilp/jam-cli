import { access, constants } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Walk up the directory tree from `startDir` to find the nearest `.git` directory.
 * Falls back to `startDir` if no git root is found.
 */
export async function findGitRoot(startDir: string = process.cwd()): Promise<string> {
  let dir = startDir;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const gitDir = join(dir, '.git');
    try {
      await access(gitDir, constants.F_OK);
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        // Reached filesystem root — no git repo found
        return startDir;
      }
      dir = parent;
    }
  }
}

/**
 * Returns the workspace root (git root if available, otherwise cwd).
 */
export async function getWorkspaceRoot(cwd: string = process.cwd()): Promise<string> {
  return findGitRoot(cwd);
}

/**
 * Returns true if the given path is inside a git repository.
 */
export async function isGitRepo(cwd: string = process.cwd()): Promise<boolean> {
  const root = await findGitRoot(cwd);
  return root !== cwd || await access(join(cwd, '.git'), constants.F_OK).then(() => true).catch(() => false);
}
