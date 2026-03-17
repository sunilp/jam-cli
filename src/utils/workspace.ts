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
 * When running in a VSCode terminal, uses the extension's context for accurate
 * git root detection even when the terminal cwd is not inside a git repo.
 */
export async function getWorkspaceRoot(cwd: string = process.cwd()): Promise<string> {
  // Try VSCode context first — it knows the correct git root for the active file
  const port = process.env['JAM_VSCODE_LM_PORT'];
  if (port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/context`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const ctx = await response.json() as { gitRoot?: string | null };
        if (ctx.gitRoot) return ctx.gitRoot;
      }
    } catch {
      // Server not reachable, fall through
    }
  }
  return findGitRoot(cwd);
}

/**
 * Returns true if the given path is inside a git repository.
 */
export async function isGitRepo(cwd: string = process.cwd()): Promise<boolean> {
  const root = await findGitRoot(cwd);
  return root !== cwd || await access(join(cwd, '.git'), constants.F_OK).then(() => true).catch(() => false);
}
