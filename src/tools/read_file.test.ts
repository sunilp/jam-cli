import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { readFileTool } from './read_file.js';
import type { ToolContext } from './types.js';

let tmpDir: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'jam-read-test-'));
  ctx = { workspaceRoot: tmpDir, cwd: tmpDir };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('read_file tool', () => {
  it('reads a file and returns numbered lines', async () => {
    await writeFile(join(tmpDir, 'hello.txt'), 'line one\nline two\nline three');
    const result = await readFileTool.execute({ path: 'hello.txt' }, ctx);
    expect(result.output).toContain('     1\tline one');
    expect(result.output).toContain('     2\tline two');
    expect(result.output).toContain('     3\tline three');
  });

  it('respects startLine and endLine (1-based, inclusive)', async () => {
    const content = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    await writeFile(join(tmpDir, 'lines.txt'), content);
    const result = await readFileTool.execute({ path: 'lines.txt', startLine: 3, endLine: 5 }, ctx);
    expect(result.output).toContain('     3\tline 3');
    expect(result.output).toContain('     4\tline 4');
    expect(result.output).toContain('     5\tline 5');
    expect(result.output).not.toContain('line 2');
    expect(result.output).not.toContain('line 6');
  });

  it('throws INPUT_FILE_NOT_FOUND when file does not exist', async () => {
    await expect(
      readFileTool.execute({ path: 'nonexistent.txt' }, ctx)
    ).rejects.toMatchObject({ code: 'INPUT_FILE_NOT_FOUND' });
  });

  it('throws INPUT_MISSING when path is empty', async () => {
    await expect(
      readFileTool.execute({ path: '' }, ctx)
    ).rejects.toMatchObject({ code: 'INPUT_MISSING' });
  });

  it('throws INPUT_MISSING when path is not a string', async () => {
    await expect(
      readFileTool.execute({ path: 42 }, ctx)
    ).rejects.toMatchObject({ code: 'INPUT_MISSING' });
  });

  it('includes correct metadata', async () => {
    await writeFile(join(tmpDir, 'meta.txt'), 'a\nb\nc');
    const result = await readFileTool.execute({ path: 'meta.txt' }, ctx);
    expect(result.metadata).toMatchObject({
      totalLines: 3,
      startLine: 1,
      endLine: 3,
      truncated: false,
    });
  });

  it('reads a file in a subdirectory', async () => {
    await mkdir(join(tmpDir, 'sub'), { recursive: true });
    await writeFile(join(tmpDir, 'sub', 'deep.txt'), 'deep content');
    const result = await readFileTool.execute({ path: 'sub/deep.txt' }, ctx);
    expect(result.output).toContain('deep content');
  });

  it('pads line numbers to 6 characters', async () => {
    await writeFile(join(tmpDir, 'single.txt'), 'only line');
    const result = await readFileTool.execute({ path: 'single.txt' }, ctx);
    expect(result.output).toMatch(/^\s+1\t/);
  });

  it('clamps startLine to 1 if below 1', async () => {
    await writeFile(join(tmpDir, 'clamp.txt'), 'line one\nline two');
    const result = await readFileTool.execute({ path: 'clamp.txt', startLine: -5 }, ctx);
    expect(result.output).toContain('     1\tline one');
  });

  it('returns all lines when neither startLine nor endLine provided', async () => {
    await writeFile(join(tmpDir, 'all.txt'), 'a\nb\nc\nd');
    const result = await readFileTool.execute({ path: 'all.txt' }, ctx);
    expect(result.metadata).toMatchObject({ startLine: 1, endLine: 4 });
  });
});
