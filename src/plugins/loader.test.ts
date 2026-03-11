import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverPlugins, loadPluginModule } from './loader.js';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jam-plugin-test-'));
}

function createPlugin(
  dir: string,
  name: string,
  manifest: Record<string, unknown>,
  indexContent?: string,
): string {
  const pluginDir = join(dir, name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'jam-plugin.json'), JSON.stringify(manifest));
  if (indexContent) {
    writeFileSync(join(pluginDir, 'index.js'), indexContent);
  }
  return pluginDir;
}

describe('discoverPlugins', () => {
  it('returns empty array for nonexistent directory', () => {
    const result = discoverPlugins(['/tmp/no-such-dir-jam-test']);
    expect(result).toEqual([]);
  });

  it('returns empty array for empty directory', () => {
    const dir = createTempDir();
    const result = discoverPlugins([dir]);
    expect(result).toEqual([]);
  });

  it('discovers a valid plugin', () => {
    const dir = createTempDir();
    createPlugin(dir, 'my-plugin', {
      name: 'my-plugin',
      version: '1.0.0',
      commands: ['test'],
    }, 'export function register() {}');

    const result = discoverPlugins([dir]);
    expect(result).toHaveLength(1);
    expect(result[0]!.manifest.name).toBe('my-plugin');
    expect(result[0]!.manifest.version).toBe('1.0.0');
  });

  it('skips plugins without index.js', () => {
    const dir = createTempDir();
    createPlugin(dir, 'no-entry', {
      name: 'no-entry',
      version: '1.0.0',
    });
    // No index.js created

    const result = discoverPlugins([dir]);
    expect(result).toHaveLength(0);
  });

  it('skips plugins with invalid manifest', () => {
    const dir = createTempDir();
    const pluginDir = join(dir, 'bad-manifest');
    mkdirSync(pluginDir);
    writeFileSync(join(pluginDir, 'jam-plugin.json'), 'not valid json');
    writeFileSync(join(pluginDir, 'index.js'), 'export function register() {}');

    const result = discoverPlugins([dir]);
    expect(result).toHaveLength(0);
  });

  it('skips plugins with non-kebab-case names', () => {
    const dir = createTempDir();
    createPlugin(dir, 'bad-name', {
      name: 'BadName', // not kebab-case
      version: '1.0.0',
    }, 'export function register() {}');

    const result = discoverPlugins([dir]);
    expect(result).toHaveLength(0);
  });

  it('deduplicates plugins by name (first wins)', () => {
    const dir1 = createTempDir();
    const dir2 = createTempDir();
    createPlugin(dir1, 'dupe', {
      name: 'dupe',
      version: '1.0.0',
    }, 'export function register() {}');
    createPlugin(dir2, 'dupe', {
      name: 'dupe',
      version: '2.0.0',
    }, 'export function register() {}');

    const result = discoverPlugins([dir1, dir2]);
    expect(result).toHaveLength(1);
    expect(result[0]!.manifest.version).toBe('1.0.0');
  });

  it('discovers plugins from multiple directories', () => {
    const dir1 = createTempDir();
    const dir2 = createTempDir();
    createPlugin(dir1, 'alpha', { name: 'alpha', version: '1.0.0' }, 'export function register() {}');
    createPlugin(dir2, 'beta', { name: 'beta', version: '1.0.0' }, 'export function register() {}');

    const result = discoverPlugins([dir1, dir2]);
    expect(result).toHaveLength(2);
  });
});

describe('loadPluginModule', () => {
  it('loads a module with register function', async () => {
    const dir = createTempDir();
    const entryPoint = join(dir, 'index.js');
    writeFileSync(entryPoint, 'export function register() { return "loaded"; }');

    const mod = await loadPluginModule(entryPoint);
    expect(typeof mod.register).toBe('function');
  });

  it('throws for module without register', async () => {
    const dir = createTempDir();
    const entryPoint = join(dir, 'index.js');
    writeFileSync(entryPoint, 'export const foo = 42;');

    await expect(loadPluginModule(entryPoint)).rejects.toThrow('register');
  });
});
