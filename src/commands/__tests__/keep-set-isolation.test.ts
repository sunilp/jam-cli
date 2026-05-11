import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Phase 1 isolation guard.
 *
 * The keep-set (trace + diagram + search + deps + mcp + supporting trace/* files)
 * must NEVER import from directories that are archived in Phase 1. If a future
 * change adds such an import, this test fails and forces a deliberate decision.
 */

const ARCHIVE_BOUND_PATTERNS = [
  /from ['"]\.{1,2}\/(.*\/)?agent\//,
  /from ['"]\.{1,2}\/(.*\/)?tools\//,
  /from ['"]\.{1,2}\/(.*\/)?intel\//,
  /from ['"]\.{1,2}\/(.*\/)?utils\/agent['"]/,
  /from ['"]\.{1,2}\/(.*\/)?utils\/memory['"]/,
  /from ['"]\.{1,2}\/(.*\/)?utils\/critic['"]/,
  /from ['"]\.{1,2}\/(.*\/)?utils\/past-sessions['"]/,
  /from ['"]\.{1,2}\/(.*\/)?utils\/index-builder['"]/,
  /from ['"]\.{1,2}\/(.*\/)?utils\/cache['"]/,
];

const KEEP_SET = [
  'src/commands/trace.ts',
  'src/commands/diagram.ts',
  'src/commands/search.ts',
  'src/commands/deps.ts',
  'src/commands/mcp.ts',
];

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...await listTsFiles(full));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('keep-set isolation (Phase 1 guard)', () => {
  it('keep-set commands do not import archive-bound modules', async () => {
    for (const file of KEEP_SET) {
      const contents = await readFile(file, 'utf-8');
      for (const pattern of ARCHIVE_BOUND_PATTERNS) {
        expect(contents, `${file} matches archive-bound import ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('src/trace/** does not import archive-bound modules', async () => {
    const files = await listTsFiles('src/trace');
    for (const file of files) {
      const contents = await readFile(file, 'utf-8');
      for (const pattern of ARCHIVE_BOUND_PATTERNS) {
        expect(contents, `${file} matches archive-bound import ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
