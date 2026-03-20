// src/intel/conventions.test.ts

import { describe, it, expect } from 'vitest';
import { analyzeConventions } from './conventions.js';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

describe('analyzeConventions', () => {
  it('detects TypeScript language', async () => {
    const profile = await analyzeConventions(ROOT);
    expect(profile.language).toBe('typescript');
  });

  it('detects npm package manager', async () => {
    const profile = await analyzeConventions(ROOT);
    expect(profile.packageManager).toBe('npm');
  });

  it('detects vitest test framework', async () => {
    const profile = await analyzeConventions(ROOT);
    expect(profile.testFramework).toBe('vitest');
  });

  it('detects code style', async () => {
    const profile = await analyzeConventions(ROOT);
    expect(profile.codeStyle.indent).toBe('spaces');
    expect(profile.codeStyle.indentSize).toBe(2);
    expect(profile.codeStyle.quotes).toBe('single');
    expect(profile.codeStyle.semicolons).toBe(true);
  });

  it('detects test location as co-located', async () => {
    const profile = await analyzeConventions(ROOT);
    // jam-cli has co-located tests (*.test.ts next to source)
    expect(profile.testNaming).toContain('.test.ts');
  });

  it('detects conventional commit style', async () => {
    const profile = await analyzeConventions(ROOT);
    expect(profile.commitConvention).toBe('conventional');
  });
});
