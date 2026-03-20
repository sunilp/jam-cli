import { execFile, spawnSync } from 'child_process';
import type { SandboxConfig } from './types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SandboxStrategy = 'sandbox-exec' | 'unshare' | 'firejail' | 'permissions-only';

// ── Strategy Detection ────────────────────────────────────────────────────────

/**
 * Detect the best available sandbox strategy for the current (or given) platform.
 * On darwin → sandbox-exec (deprecated but functional on macOS 10.15+).
 * On linux  → firejail if available, else unshare if available, else permissions-only.
 * Elsewhere → permissions-only.
 */
export function detectSandboxStrategy(platform?: string): SandboxStrategy {
  const os = platform ?? process.platform;

  if (os === 'darwin') {
    return 'sandbox-exec';
  }

  if (os === 'linux') {
    const firejailCheck = spawnSync('which', ['firejail'], { encoding: 'utf8' });
    if (firejailCheck.status === 0 && firejailCheck.stdout.trim().length > 0) {
      return 'firejail';
    }

    const unshareCheck = spawnSync('which', ['unshare'], { encoding: 'utf8' });
    if (unshareCheck.status === 0 && unshareCheck.stdout.trim().length > 0) {
      return 'unshare';
    }

    return 'permissions-only';
  }

  return 'permissions-only';
}

// ── Seatbelt Profile Builder ──────────────────────────────────────────────────

/**
 * Build a macOS sandbox-exec (seatbelt) profile that:
 *   - allows everything by default
 *   - denies file writes outside workspaceRoot and /tmp
 *   - optionally denies all network activity
 */
function buildSeatbeltProfile(workspaceRoot: string, config: SandboxConfig): string {
  const lines: string[] = [
    '(version 1)',
    '(allow default)',
    // Deny writes everywhere except workspaceRoot and /tmp
    `(deny file-write*`,
    `  (subpath "/")`,
    `  (require-not (subpath "${workspaceRoot}"))`,
    `  (require-not (subpath "/tmp")))`,
  ];

  if (config.network === 'blocked') {
    lines.push('(deny network*)');
  }

  return lines.join('\n');
}

// ── Arg Builder ───────────────────────────────────────────────────────────────

/**
 * Wrap a shell command string for sandboxed execution according to the chosen
 * strategy.  Returns `{ command, args }` suitable for passing to execFile.
 */
export function buildSandboxArgs(
  command: string,
  workspaceRoot: string,
  config: SandboxConfig,
  strategy: SandboxStrategy,
): { command: string; args: string[] } {
  switch (strategy) {
    case 'sandbox-exec': {
      const profile = buildSeatbeltProfile(workspaceRoot, config);
      return {
        command: 'sandbox-exec',
        args: ['-p', profile, '/bin/bash', '-c', command],
      };
    }

    case 'firejail': {
      return {
        command: 'firejail',
        args: ['--noprofile', `--whitelist=${workspaceRoot}`, '--', '/bin/bash', '-c', command],
      };
    }

    case 'unshare': {
      return {
        command: 'unshare',
        args: ['-r', '-m', '/bin/bash', '-c', command],
      };
    }

    case 'permissions-only': {
      // Run through shell for consistent behavior across platforms.
      return { command: '/bin/sh', args: ['-c', command] };
    }
  }
}

// ── Executor ──────────────────────────────────────────────────────────────────

/**
 * Execute a shell command inside the appropriate sandbox.
 * Returns stdout, stderr, and the process exit code.
 * On timeout, kills the child and returns exitCode -1.
 */
export async function executeSandboxed(
  command: string,
  workspaceRoot: string,
  config: SandboxConfig,
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const strategy = detectSandboxStrategy();
  const { command: exe, args } = buildSandboxArgs(command, workspaceRoot, config, strategy);
  const timeoutMs = options?.timeout ?? config.timeout ?? 60_000;

  return new Promise((resolve) => {
    let settled = false;

    const child = execFile(exe, args, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // child.exitCode is set when the callback fires; fall back to parsing
      // the error object for non-zero exits.
      const exitCode =
        child.exitCode !== null && child.exitCode !== undefined
          ? child.exitCode
          : error
            ? 1
            : 0;

      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exitCode,
      });
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ stdout: '', stderr: 'Process timed out', exitCode: -1 });
    }, timeoutMs);
  });
}
