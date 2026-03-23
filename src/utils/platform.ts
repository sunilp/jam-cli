/**
 * Cross-platform helpers for Windows compatibility.
 */

import { execSync } from 'node:child_process';

export function isWindows(platform?: string): boolean {
  return (platform ?? process.platform) === 'win32';
}

/**
 * Return the platform shell command + flag for running a string command.
 */
export function shellCmd(platform?: string): { command: string; args: string[] } {
  return isWindows(platform)
    ? { command: 'cmd.exe', args: ['/c'] }
    : { command: '/bin/sh', args: ['-c'] };
}

/**
 * Kill a process cross-platform.
 * Windows doesn't support SIGTERM — use taskkill.
 */
export function killProcess(pid: number): boolean {
  try {
    if (isWindows()) {
      execSync(`taskkill /PID ${pid} /F /T`, { stdio: 'pipe', timeout: 5000 });
      return true;
    }
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a file path for display — always use forward slashes,
 * return the last N segments.
 */
export function shortPath(filePath: string, segments = 2): string {
  return filePath
    .split(/[\\/]/)
    .slice(-segments)
    .join('/');
}

/**
 * Whether `shell: true` should be passed to execFile/spawn
 * so that `.cmd` shims (npm, npx, jam) are resolved on Windows.
 */
export function needsShell(): boolean {
  return isWindows();
}
