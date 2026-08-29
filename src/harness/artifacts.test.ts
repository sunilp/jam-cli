import { describe, it, expect } from 'vitest';
import { ArtifactStore, preview } from './artifacts.js';

describe('ArtifactStore', () => {
  it('round-trips content by digest', () => {
    const s = new ArtifactStore(':memory:');
    const ref = s.put('hello world');
    expect(s.get(ref.digest)).toBe('hello world');
    expect(ref.size).toBe(11);
    s.close();
  });

  it('deduplicates identical content into a single stored row', () => {
    const s = new ArtifactStore(':memory:');
    const a = s.put('same');
    s.put('same');
    s.put('same');
    expect(s.count(a.digest)).toBe(1);
    s.close();
  });

  it('gives different content different digests', () => {
    const s = new ArtifactStore(':memory:');
    expect(s.put('one').digest).not.toBe(s.put('two').digest);
    s.close();
  });

  it('returns undefined for an unknown digest rather than throwing', () => {
    const s = new ArtifactStore(':memory:');
    expect(s.get('0'.repeat(64))).toBeUndefined();
    s.close();
  });
});

describe('preview', () => {
  it('returns short content unchanged', () => {
    expect(preview('one\ntwo')).toBe('one\ntwo');
  });

  it('elides the middle of long content and says how much was dropped', () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const p = preview(long, { head: 5, tail: 5 });
    expect(p).toContain('line 0');
    expect(p).toContain('line 499');
    expect(p).not.toContain('line 250');
    expect(p).toContain('490 lines elided');
  });

  it('always keeps lines that look like errors', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    lines[150] = 'Error: boom';
    const p = preview(lines.join('\n'), { head: 2, tail: 2 });
    expect(p).toContain('Error: boom');
  });

  it('bounds a single enormous line, which line counting alone cannot', () => {
    const oneHugeLine = JSON.stringify({ content: 'x'.repeat(200_000) });
    const p = preview(oneHugeLine);
    expect(p.length).toBeLessThan(10_000);
    expect(p).toContain('more characters elided');
  });

  it('keeps the error block and tail even when every line is long', () => {
    const long = (s: string): string => s + ' '.repeat(400);
    const lines = Array.from({ length: 300 }, (_, i) => long(`line ${i}`));
    lines[150] = long('Error: the thing exploded');
    const p = preview(lines.join('\n'), { head: 20, tail: 20 });

    expect(p.length).toBeLessThan(20_000);
    expect(p).toContain('Error: the thing exploded');
    expect(p).toContain('line 299');
    expect(p).toContain('line 0');
  });

  it('says so when it omits error lines beyond the cap', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    for (let i = 100; i < 130; i++) lines[i] = `Error: boom ${i}`;
    const p = preview(lines.join('\n'), { head: 2, tail: 2 });
    expect(p).toContain('Error: boom 100');
    expect(p).toContain('10 more error lines omitted');
  });
});
