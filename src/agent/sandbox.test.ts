import { describe, it, expect } from 'vitest';
import { detectSandboxStrategy, buildSandboxArgs, executeSandboxed } from './sandbox.js';
import type { SandboxConfig } from './types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const defaultConfig: SandboxConfig = {
  filesystem: 'workspace-only',
  network: 'allowed',
  timeout: 60_000,
};

const workspaceRoot = '/tmp/test-workspace';

// ── detectSandboxStrategy ─────────────────────────────────────────────────────

describe('detectSandboxStrategy', () => {
  it('returns sandbox-exec on darwin', () => {
    expect(detectSandboxStrategy('darwin')).toBe('sandbox-exec');
  });

  it('returns permissions-only on win32', () => {
    expect(detectSandboxStrategy('win32')).toBe('permissions-only');
  });

  it('returns a valid strategy on linux (one of firejail/unshare/permissions-only)', () => {
    const result = detectSandboxStrategy('linux');
    const valid: string[] = ['firejail', 'unshare', 'permissions-only'];
    expect(valid).toContain(result);
  });
});

// ── buildSandboxArgs ──────────────────────────────────────────────────────────

describe('buildSandboxArgs', () => {
  it('wraps with sandbox-exec on darwin (command is sandbox-exec, args contain -p)', () => {
    const result = buildSandboxArgs('echo hello', workspaceRoot, defaultConfig, 'sandbox-exec');
    expect(result.command).toBe('sandbox-exec');
    expect(result.args).toContain('-p');
  });

  it('wraps with firejail (command is firejail, args contain --whitelist=)', () => {
    const result = buildSandboxArgs('echo hello', workspaceRoot, defaultConfig, 'firejail');
    expect(result.command).toBe('firejail');
    expect(result.args.some((a) => a.startsWith('--whitelist='))).toBe(true);
  });

  it('wraps with unshare (command is unshare, args contain -r and -m)', () => {
    const result = buildSandboxArgs('echo hello', workspaceRoot, defaultConfig, 'unshare');
    expect(result.command).toBe('unshare');
    expect(result.args).toContain('-r');
    expect(result.args).toContain('-m');
  });

  it('returns passthrough for permissions-only (splits command into command + args)', () => {
    const result = buildSandboxArgs('echo hello world', workspaceRoot, defaultConfig, 'permissions-only');
    expect(result.command).toBe('echo');
    expect(result.args).toEqual(['hello world']);
  });

  it('returns passthrough for permissions-only with no-arg command', () => {
    const result = buildSandboxArgs('pwd', workspaceRoot, defaultConfig, 'permissions-only');
    expect(result.command).toBe('pwd');
    expect(result.args).toEqual([]);
  });

  it('includes network deny in sandbox-exec profile when network is blocked', () => {
    const blockedConfig: SandboxConfig = { ...defaultConfig, network: 'blocked' };
    const result = buildSandboxArgs('echo hello', workspaceRoot, blockedConfig, 'sandbox-exec');
    // The profile is the second argument (after '-p')
    const profileIdx = result.args.indexOf('-p');
    expect(profileIdx).toBeGreaterThanOrEqual(0);
    const profile = result.args[profileIdx + 1];
    expect(profile).toContain('(deny network*)');
  });

  it('does not include network deny in sandbox-exec profile when network is allowed', () => {
    const result = buildSandboxArgs('echo hello', workspaceRoot, defaultConfig, 'sandbox-exec');
    const profileIdx = result.args.indexOf('-p');
    const profile = result.args[profileIdx + 1];
    expect(profile).not.toContain('(deny network*)');
  });

  it('sandbox-exec profile restricts writes to workspaceRoot and /tmp', () => {
    const result = buildSandboxArgs('echo hello', workspaceRoot, defaultConfig, 'sandbox-exec');
    const profileIdx = result.args.indexOf('-p');
    const profile = result.args[profileIdx + 1];
    expect(profile).toContain(workspaceRoot);
    expect(profile).toContain('/tmp');
    expect(profile).toContain('deny file-write*');
  });
});

// ── executeSandboxed ──────────────────────────────────────────────────────────

describe('executeSandboxed', () => {
  it('executes a simple command (echo hello) and returns stdout', async () => {
    const result = await executeSandboxed('echo hello', workspaceRoot, defaultConfig);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  it('returns non-zero exitCode for failing command', async () => {
    // `exit 1` must be run through a shell; on permissions-only that means
    // we pass the whole string as the command to bash.
    const result = await executeSandboxed('/bin/bash -c "exit 1"', workspaceRoot, defaultConfig);
    expect(result.exitCode).not.toBe(0);
  });

  it('respects timeout (sleep with short timeout returns exitCode -1)', async () => {
    const result = await executeSandboxed(
      'sleep 10',
      workspaceRoot,
      defaultConfig,
      { timeout: 100 },
    );
    expect(result.exitCode).toBe(-1);
  }, 5_000);
});
