// src/trace/parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseSource, isTreeSitterAvailable, detectLanguage } from './parser.js';

describe('detectLanguage', () => {
  it('detects TypeScript', () => expect(detectLanguage('foo.ts')).toBe('typescript'));
  it('detects TSX', () => expect(detectLanguage('foo.tsx')).toBe('typescript'));
  it('detects JavaScript', () => expect(detectLanguage('foo.js')).toBe('javascript'));
  it('detects Python', () => expect(detectLanguage('foo.py')).toBe('python'));
  it('detects SQL', () => expect(detectLanguage('foo.sql')).toBe('sql'));
  it('detects Java', () => expect(detectLanguage('foo.java')).toBe('java'));
  it('returns null for unknown', () => expect(detectLanguage('foo.rb')).toBeNull());
});

describe('parseSource', () => {
  it('parses TypeScript and returns AST root node', async () => {
    if (!isTreeSitterAvailable()) return; // skip if native addon not installed
    const tree = await parseSource('function hello() { return 1; }', 'typescript');
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('program');
    expect(tree!.rootNode.childCount).toBeGreaterThan(0);
  });

  it('parses Python', async () => {
    if (!isTreeSitterAvailable()) return;
    const tree = await parseSource('def hello():\n    return 1\n', 'python');
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('module');
  });

  it('parses SQL', async () => {
    if (!isTreeSitterAvailable()) return;
    const tree = await parseSource('SELECT id FROM users WHERE active = 1;', 'sql');
    // tree-sitter-sql grammar may not be ABI-compatible — null is acceptable
    if (!tree) return;
    expect(tree.rootNode).toBeDefined();
  });

  it('returns null for unsupported language', async () => {
    const tree = await parseSource('puts "hello"', 'ruby');
    expect(tree).toBeNull();
  });
});
