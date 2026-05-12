import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'dist', 'index.js');
const ARCHIVED = ['ask', 'chat', 'run', 'go', 'explain', 'review', 'verify',
                  'patch', 'commit', 'diff', 'jira', 'md2pdf', 'intel'];

describe('archived command migration pointer', () => {
  it.each(ARCHIVED)('points to archive/ai-suite when `jam %s` is run', (cmd) => {
    const r = spawnSync('node', [CLI, cmd], { encoding: 'utf-8' });
    const output = r.stdout + r.stderr;
    expect(output).toMatch(/removed in v0\.12/);
    expect(output).toMatch(/archive\/ai-suite/);
    expect(r.status).not.toBe(0);
  });
});
