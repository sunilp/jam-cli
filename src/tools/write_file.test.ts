import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { writeFileTool } from './write_file.js';
import type { ToolContext } from './types.js';

let tmpDir: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'jam-write-test-'));
  ctx = { workspaceRoot: tmpDir, cwd: tmpDir };
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('write_file tool', () => {
  it('writes a new file in overwrite mode (default)', async () => {
    await writeFileTool.execute({ path: 'output.txt', content: 'hello world' }, ctx);
    const written = await readFile(join(tmpDir, 'output.txt'), 'utf8');
    expect(written).toBe('hello world');
  });

  it('overwrites existing file content', async () => {
    await writeFileTool.execute({ path: 'out.txt', content: 'original' }, ctx);
    await writeFileTool.execute({ path: 'out.txt', content: 'replaced' }, ctx);
    const written = await readFile(join(tmpDir, 'out.txt'), 'utf8');
    expect(written).toBe('replaced');
  });

  it('appends to existing file when mode is "append"', async () => {
    await writeFileTool.execute({ path: 'log.txt', content: 'line1\n' }, ctx);
    await writeFileTool.execute({ path: 'log.txt', content: 'line2\n', mode: 'append' }, ctx);
    const written = await readFile(join(tmpDir, 'log.txt'), 'utf8');
    expect(written).toBe('line1\nline2\n');
  });

  it('creates parent directories automatically', async () => {
    await writeFileTool.execute({ path: 'a/b/c/file.txt', content: 'nested' }, ctx);
    const written = await readFile(join(tmpDir, 'a', 'b', 'c', 'file.txt'), 'utf8');
    expect(written).toBe('nested');
  });

  it('returns output with correct byte count', async () => {
    const content = 'hello';
    const result = await writeFileTool.execute({ path: 'bytes.txt', content }, ctx);
    const byteLength = Buffer.byteLength(content, 'utf8');
    expect(result.output).toBe(`Written ${byteLength} bytes to bytes.txt`);
  });

  it('reports correct byte count for multi-byte characters', async () => {
    const content = '😀'; // 4 bytes in UTF-8
    const result = await writeFileTool.execute({ path: 'emoji.txt', content }, ctx);
    expect(result.output).toBe(`Written 4 bytes to emoji.txt`);
  });

  it('throws INPUT_MISSING when path is empty', async () => {
    await expect(
      writeFileTool.execute({ path: '', content: 'x' }, ctx)
    ).rejects.toMatchObject({ code: 'INPUT_MISSING' });
  });

  it('throws INPUT_MISSING when content is not a string', async () => {
    await expect(
      writeFileTool.execute({ path: 'x.txt', content: 42 }, ctx)
    ).rejects.toMatchObject({ code: 'INPUT_MISSING' });
  });

  it('includes metadata in result', async () => {
    const content = 'test content';
    const result = await writeFileTool.execute({ path: 'meta.txt', content }, ctx);
    expect(result.metadata).toMatchObject({
      mode: 'overwrite',
      bytes: Buffer.byteLength(content, 'utf8'),
    });
  });

  it('metadata mode is "append" when append mode used', async () => {
    const result = await writeFileTool.execute({
      path: 'appended.txt',
      content: 'data',
      mode: 'append',
    }, ctx);
    expect(result.metadata).toMatchObject({ mode: 'append' });
  });

  it('writes empty string without error', async () => {
    const result = await writeFileTool.execute({ path: 'empty.txt', content: '' }, ctx);
    const written = await readFile(join(tmpDir, 'empty.txt'), 'utf8');
    expect(written).toBe('');
    expect(result.output).toBe('Written 0 bytes to empty.txt');
  });
});
