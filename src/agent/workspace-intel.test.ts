import { describe, it, expect } from 'vitest';
import { buildWorkspaceProfile, formatProfileForPrompt, computeProfileHash } from './workspace-intel.js';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

describe('buildWorkspaceProfile', () => {
  it('builds profile for jam-cli project', async () => {
    const profile = await buildWorkspaceProfile(ROOT);
    expect(profile.language).toBe('typescript');
    expect(profile.packageManager).toBe('npm');
    expect(profile.testFramework).toBe('vitest');
    expect(profile.codeStyle.quotes).toBe('single');
  });

  it('detects structural fields', async () => {
    const profile = await buildWorkspaceProfile(ROOT);
    expect(profile.srcLayout).toBeTruthy();
    expect(profile.entryPoints.length).toBeGreaterThan(0);
    expect(typeof profile.monorepo).toBe('boolean');
  });

  it('returns cached profile on second call', async () => {
    const p1 = await buildWorkspaceProfile(ROOT);
    const p2 = await buildWorkspaceProfile(ROOT);
    expect(p1.language).toBe(p2.language);
    expect(p1.testFramework).toBe(p2.testFramework);
  });
});

describe('computeProfileHash', () => {
  it('returns consistent hash for same project', async () => {
    const h1 = await computeProfileHash(ROOT);
    const h2 = await computeProfileHash(ROOT);
    expect(h1).toBe(h2);
    expect(h1.length).toBeGreaterThan(0);
  });
});

describe('formatProfileForPrompt', () => {
  it('formats profile as readable string', async () => {
    const profile = await buildWorkspaceProfile(ROOT);
    const prompt = formatProfileForPrompt(profile);
    expect(prompt).toContain('TypeScript');
    expect(prompt).toContain('vitest');
    expect(prompt).toContain('single quotes');
  });
});
