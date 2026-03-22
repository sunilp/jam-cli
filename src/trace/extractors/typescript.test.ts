// src/trace/extractors/typescript.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { isTreeSitterAvailable, parseSource } from '../parser.js';
import { TypeScriptExtractor } from './typescript.js';

const extractor = new TypeScriptExtractor();

function extract(source: string) {
  // Synchronous parse for tests — parseSource is async but fast
  return parseSource(source, 'typescript').then(tree => {
    if (!tree) throw new Error('Parse failed');
    return extractor.extract(tree.rootNode, source);
  });
}

describe('TypeScriptExtractor', () => {
  beforeAll(() => {
    if (!isTreeSitterAvailable()) {
      console.log('tree-sitter not available — skipping extractor tests');
    }
  });

  it('extracts exported function declarations', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract(
      'export async function processData(input: string): Promise<Result> {\n  return transform(input);\n}'
    );
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.name).toBe('processData');
    expect(result.symbols[0]!.kind).toBe('function');
  });

  it('extracts arrow functions assigned to const', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract('export const handler = (req: Request) => { fetch(url); };');
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.name).toBe('handler');
  });

  it('extracts class declarations and methods', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract(
      'export class UserService {\n  async getUser(id: number) { return db.query(id); }\n}'
    );
    const classSymbol = result.symbols.find(s => s.name === 'UserService');
    const methodSymbol = result.symbols.find(s => s.name === 'getUser');
    expect(classSymbol).toBeDefined();
    expect(classSymbol!.kind).toBe('class');
    expect(methodSymbol).toBeDefined();
    expect(methodSymbol!.kind).toBe('method');
  });

  it('extracts call expressions', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract(
      'function main() {\n  const x = processData("hello");\n  console.log(x);\n}'
    );
    const calls = result.calls.filter(c => c.calleeName === 'processData');
    expect(calls).toHaveLength(1);
  });

  it('filters out console builtin calls', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract('function main() { console.log("hi"); }');
    const consoleCalls = result.calls.filter(c => c.callerName === 'console' || c.calleeName === 'console');
    expect(consoleCalls).toHaveLength(0);
  });

  it('extracts import statements', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract(
      "import { processData, type Result } from './processor.js';\nimport chalk from 'chalk';"
    );
    expect(result.imports.length).toBeGreaterThanOrEqual(2);
    const pd = result.imports.find(i => i.symbolName === 'processData');
    expect(pd).toBeDefined();
    expect(pd!.sourceModule).toBe('./processor.js');
  });

  it('extracts default imports', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract("import chalk from 'chalk';");
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]!.symbolName).toBe('chalk');
    expect(result.imports[0]!.sourceModule).toBe('chalk');
  });

  it('extracts function signature and return type', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract(
      'function greet(name: string, age: number): string { return name; }'
    );
    expect(result.symbols).toHaveLength(1);
    const sym = result.symbols[0]!;
    expect(sym.signature).toBe('(name: string, age: number)');
    expect(sym.returnType).toBe('string');
  });

  it('records caller name in call expressions', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract(
      'function main() {\n  const x = processData("hello");\n}'
    );
    const calls = result.calls.filter(c => c.calleeName === 'processData');
    expect(calls[0]!.callerName).toBe('main');
  });

  it('extracts non-exported function declarations', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract('function helper(x: number) { return x * 2; }');
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.name).toBe('helper');
    expect(result.symbols[0]!.kind).toBe('function');
  });

  it('extracts line numbers correctly', async () => {
    if (!isTreeSitterAvailable()) return;
    const result = await extract(
      'function a() {}\nfunction b() {}'
    );
    expect(result.symbols).toHaveLength(2);
    const a = result.symbols.find(s => s.name === 'a')!;
    const b = result.symbols.find(s => s.name === 'b')!;
    expect(a.line).toBe(1);
    expect(b.line).toBe(2);
  });
});
