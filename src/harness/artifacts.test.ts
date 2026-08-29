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

  it('deduplicates identical content', () => {
    const s = new ArtifactStore(':memory:');
    expect(s.put('same').digest).toBe(s.put('same').digest);
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
});
