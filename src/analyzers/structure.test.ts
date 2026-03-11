import { describe, it, expect } from 'vitest';
import { extractSymbols } from './structure.js';

describe('extractSymbols', () => {
  it('extracts exported classes', () => {
    const code = 'export class MyClass {}';
    const symbols = extractSymbols(code, 'test.ts', 'test');
    expect(symbols).toContainEqual(
      expect.objectContaining({ name: 'MyClass', kind: 'class', exported: true }),
    );
  });

  it('extracts exported interfaces', () => {
    const code = 'export interface MyInterface {}';
    const symbols = extractSymbols(code, 'test.ts', 'test');
    expect(symbols).toContainEqual(
      expect.objectContaining({ name: 'MyInterface', kind: 'interface', exported: true }),
    );
  });

  it('extracts exported types', () => {
    const code = 'export type MyType = string;';
    const symbols = extractSymbols(code, 'test.ts', 'test');
    expect(symbols).toContainEqual(
      expect.objectContaining({ name: 'MyType', kind: 'type', exported: true }),
    );
  });

  it('extracts exported functions', () => {
    const code = 'export function myFunc() {}';
    const symbols = extractSymbols(code, 'test.ts', 'test');
    expect(symbols).toContainEqual(
      expect.objectContaining({ name: 'myFunc', kind: 'function', exported: true }),
    );
  });

  it('extracts exported async functions', () => {
    const code = 'export async function myAsync() {}';
    const symbols = extractSymbols(code, 'test.ts', 'test');
    expect(symbols).toContainEqual(
      expect.objectContaining({ name: 'myAsync', kind: 'function', exported: true }),
    );
  });

  it('extracts exported enums', () => {
    const code = 'export enum MyEnum { A, B }';
    const symbols = extractSymbols(code, 'test.ts', 'test');
    expect(symbols).toContainEqual(
      expect.objectContaining({ name: 'MyEnum', kind: 'enum', exported: true }),
    );
  });

  it('extracts exported consts', () => {
    const code = 'export const MY_CONST = 42;';
    const symbols = extractSymbols(code, 'test.ts', 'test');
    expect(symbols).toContainEqual(
      expect.objectContaining({ name: 'MY_CONST', exported: true }),
    );
  });

  it('extracts default exports', () => {
    const code = 'export default class DefaultClass {}';
    const symbols = extractSymbols(code, 'test.ts', 'test');
    expect(symbols).toContainEqual(
      expect.objectContaining({ name: 'DefaultClass', kind: 'class' }),
    );
  });

  it('sets file and module correctly', () => {
    const code = 'export function hello() {}';
    const symbols = extractSymbols(code, 'src/utils/hello.ts', 'utils');
    expect(symbols[0]).toMatchObject({
      file: 'src/utils/hello.ts',
      module: 'utils',
    });
  });

  it('returns empty for no exports', () => {
    const code = 'const x = 42;\nfunction internal() {}';
    expect(extractSymbols(code, 'test.ts', 'test')).toEqual([]);
  });
});
