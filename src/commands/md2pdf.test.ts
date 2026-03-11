import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMd2Pdf } from './md2pdf.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;
let stdoutData: string;
let stderrData: string;
let exitCode: number | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'md2pdf-test-'));
  stdoutData = '';
  stderrData = '';
  exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdoutData += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderrData += String(chunk);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null | undefined) => {
    exitCode = typeof code === 'number' ? code : 0;
    throw new Error(`process.exit(${code})`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function writeMd(name: string, content: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, content);
  return path;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runMd2Pdf', () => {
  it('shows usage when no file is provided', async () => {
    await runMd2Pdf(undefined, {});
    expect(stderrData).toContain('Usage');
    expect(stderrData).toContain('md2pdf');
  });

  it('exits with error for nonexistent file', async () => {
    await expect(runMd2Pdf('/tmp/no-such-file-md2pdf.md', {})).rejects.toThrow('process.exit');
    expect(exitCode).toBe(1);
    expect(stderrData).toContain('Cannot read file');
  });

  it('exits with error for unknown style', async () => {
    const mdPath = writeMd('test.md', '# Hello');
    await expect(runMd2Pdf(mdPath, { style: 'fancy' })).rejects.toThrow('process.exit');
    expect(exitCode).toBe(1);
    expect(stderrData).toContain('Unknown style');
  });

  it('converts a simple markdown file to PDF', async () => {
    const mdPath = writeMd('simple.md', '# Title\n\nHello world.\n');
    const pdfPath = join(tmpDir, 'simple.pdf');

    await runMd2Pdf(mdPath, {});

    expect(existsSync(pdfPath)).toBe(true);
    const pdfBytes = readFileSync(pdfPath);
    // PDF files start with %PDF
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(stdoutData).toContain('simple.md');
    expect(stdoutData).toContain('simple.pdf');
  });

  it('uses custom output path', async () => {
    const mdPath = writeMd('input.md', '# Test');
    const outPath = join(tmpDir, 'custom-output.pdf');

    await runMd2Pdf(mdPath, { output: outPath });

    expect(existsSync(outPath)).toBe(true);
    expect(stdoutData).toContain('custom-output.pdf');
  });

  it('applies different style presets', async () => {
    const mdPath = writeMd('styled.md', '# Heading\n\nParagraph.\n');

    for (const style of ['default', 'minimal', 'academic']) {
      const outPath = join(tmpDir, `styled-${style}.pdf`);
      await runMd2Pdf(mdPath, { style, output: outPath });
      expect(existsSync(outPath)).toBe(true);
    }
  });

  it('handles all markdown elements without crashing', async () => {
    const md = [
      '# Heading 1',
      '## Heading 2',
      '### Heading 3',
      '',
      'A paragraph with **bold**, *italic*, and `code`.',
      '',
      '- Bullet one',
      '- Bullet two',
      '',
      '1. Ordered one',
      '2. Ordered two',
      '',
      '> A blockquote.',
      '',
      '---',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '[Link](https://example.com)',
    ].join('\n');

    const mdPath = writeMd('full.md', md);
    const outPath = join(tmpDir, 'full.pdf');

    await runMd2Pdf(mdPath, { output: outPath });

    expect(existsSync(outPath)).toBe(true);
    const pdfBytes = readFileSync(outPath);
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');
    // Should be a reasonable size (not empty / corrupt)
    expect(pdfBytes.length).toBeGreaterThan(500);
  });

  it('sets custom title in PDF metadata', async () => {
    const mdPath = writeMd('meta.md', '# Doc\n\nContent.\n');
    const outPath = join(tmpDir, 'meta.pdf');

    await runMd2Pdf(mdPath, { output: outPath, title: 'My Custom Title' });

    expect(existsSync(outPath)).toBe(true);
    // The title should appear in the PDF binary
    const pdfContent = readFileSync(outPath, 'latin1');
    expect(pdfContent).toContain('My Custom Title');
  });

  it('accepts custom font size', async () => {
    const mdPath = writeMd('fontsize.md', '# Big\n\nBig text.\n');
    const outPath = join(tmpDir, 'fontsize.pdf');

    await runMd2Pdf(mdPath, { output: outPath, fontSize: 14 });
    expect(existsSync(outPath)).toBe(true);
  });
});
