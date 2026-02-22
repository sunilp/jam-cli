import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import type { ToolContext } from './types.js';

// ---------------------------------------------------------------------------
// Mock node:child_process so that ripgrep always fails, forcing the Node.js
// fallback path. This makes tests deterministic without requiring rg installed.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => {
  function makeEmitter() {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
    return {
      on(event: string, fn: (...args: unknown[]) => void) {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(fn);
        return this;
      },
      emit(event: string, ...args: unknown[]) {
        (handlers[event] ?? []).forEach((fn) => fn(...args));
      },
    };
  }

  return {
    spawn: vi.fn().mockImplementation(() => {
      const child = makeEmitter() as ReturnType<typeof makeEmitter> & {
        stdout: ReturnType<typeof makeEmitter>;
        stderr: ReturnType<typeof makeEmitter>;
      };
      child.stdout = makeEmitter();
      child.stderr = makeEmitter();
      // Emit error asynchronously to trigger the fallback path in search_text
      setTimeout(() => {
        child.emit('error', new Error('spawn rg ENOENT'));
      }, 0);
      return child;
    }),
  };
});

// Import AFTER the mock is set up
const { searchTextTool } = await import('./search_text.js');

let tmpDir: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'jam-search-test-'));
  ctx = { workspaceRoot: tmpDir, cwd: tmpDir };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('search_text tool (Node.js fallback)', () => {
  it('finds matching lines in files', async () => {
    await writeFile(join(tmpDir, 'foo.ts'), 'const x = 1;\n// TODO: fix this\nconst z = 3;');
    const result = await searchTextTool.execute({ query: 'TODO' }, ctx);
    expect(result.output).toContain('TODO');
    expect(result.metadata).toMatchObject({ usedFallback: true, matchCount: 1 });
  });

  it('returns "No matches found." when nothing matches', async () => {
    await writeFile(join(tmpDir, 'empty.ts'), 'nothing interesting here');
    const result = await searchTextTool.execute({ query: 'UNIQUEPATTERNXYZ_99' }, ctx);
    expect(result.output).toBe('No matches found.');
    expect(result.metadata).toMatchObject({ matchCount: 0 });
  });

  it('respects maxResults limit', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `match line ${i}`).join('\n');
    await writeFile(join(tmpDir, 'many.txt'), lines);
    const result = await searchTextTool.execute({ query: 'match line', maxResults: 5 }, ctx);
    expect(result.metadata?.['matchCount']).toBeLessThanOrEqual(5);
  });

  it('filters by glob extension', async () => {
    await writeFile(join(tmpDir, 'code.ts'), 'needle in typescript');
    await writeFile(join(tmpDir, 'doc.md'), 'needle in markdown');
    const result = await searchTextTool.execute({ query: 'needle', glob: '*.ts' }, ctx);
    expect(result.output).toContain('code.ts');
    expect(result.output).not.toContain('doc.md');
  });

  it('throws INPUT_MISSING when query is empty', async () => {
    await expect(
      searchTextTool.execute({ query: '' }, ctx)
    ).rejects.toMatchObject({ code: 'INPUT_MISSING' });
  });

  it('searches case-insensitively', async () => {
    await writeFile(join(tmpDir, 'case.txt'), 'HELLO world');
    const result = await searchTextTool.execute({ query: 'hello' }, ctx);
    expect(result.output).toContain('HELLO world');
  });

  it('skips hidden directories', async () => {
    await mkdir(join(tmpDir, '.git'));
    await writeFile(join(tmpDir, '.git', 'config'), 'needle');
    await writeFile(join(tmpDir, 'visible.txt'), 'no match here');
    const result = await searchTextTool.execute({ query: 'needle' }, ctx);
    expect(result.output).toBe('No matches found.');
  });

  it('skips node_modules', async () => {
    await mkdir(join(tmpDir, 'node_modules'));
    await writeFile(join(tmpDir, 'node_modules', 'pkg.js'), 'needle');
    await writeFile(join(tmpDir, 'src.ts'), 'no match');
    const result = await searchTextTool.execute({ query: 'needle' }, ctx);
    expect(result.output).toBe('No matches found.');
  });

  it('includes relative file path and line number in output', async () => {
    await writeFile(join(tmpDir, 'target.txt'), 'first line\nfind me here\nlast line');
    const result = await searchTextTool.execute({ query: 'find me' }, ctx);
    expect(result.output).toContain('target.txt:2:');
  });

  it('searches across multiple files', async () => {
    await writeFile(join(tmpDir, 'a.txt'), 'pattern alpha');
    await writeFile(join(tmpDir, 'b.txt'), 'pattern beta');
    const result = await searchTextTool.execute({ query: 'pattern' }, ctx);
    expect(result.metadata?.['matchCount']).toBe(2);
  });
});
