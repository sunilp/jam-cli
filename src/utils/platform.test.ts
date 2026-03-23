import { describe, it, expect } from 'vitest';
import { isWindows, shellCmd, shortPath, needsShell } from './platform.js';

describe('platform utils', () => {
  it('isWindows returns boolean', () => {
    expect(typeof isWindows()).toBe('boolean');
  });

  it('isWindows detects win32', () => {
    expect(isWindows('win32')).toBe(true);
    expect(isWindows('darwin')).toBe(false);
    expect(isWindows('linux')).toBe(false);
  });

  it('shellCmd returns cmd.exe on win32', () => {
    expect(shellCmd('win32')).toEqual({ command: 'cmd.exe', args: ['/c'] });
  });

  it('shellCmd returns /bin/sh on non-windows', () => {
    expect(shellCmd('linux')).toEqual({ command: '/bin/sh', args: ['-c'] });
    expect(shellCmd('darwin')).toEqual({ command: '/bin/sh', args: ['-c'] });
  });

  it('shortPath normalizes backslashes', () => {
    expect(shortPath('src\\commands\\run.ts')).toBe('commands/run.ts');
  });

  it('shortPath normalizes forward slashes', () => {
    expect(shortPath('src/commands/run.ts')).toBe('commands/run.ts');
  });

  it('shortPath supports custom segment count', () => {
    expect(shortPath('a/b/c/d.ts', 3)).toBe('b/c/d.ts');
  });

  it('needsShell returns boolean', () => {
    expect(typeof needsShell()).toBe('boolean');
  });
});
