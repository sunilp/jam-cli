import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PluginManager } from './manager.js';

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jam-pm-test-'));
}

function createPlugin(
  dir: string, name: string, version = '1.0.0', code = 'export function register() {}',
): void {
  const pluginDir = join(dir, name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'jam-plugin.json'), JSON.stringify({
    name, version, commands: [name],
  }));
  writeFileSync(join(pluginDir, 'index.js'), code);
}

describe('PluginManager', () => {
  it('loads plugins from directories', async () => {
    const dir = createTempDir();
    createPlugin(dir, 'test-plugin');

    const manager = new PluginManager();
    await manager.loadAll([dir]);

    expect(manager.hasPlugins).toBe(true);
    expect(manager.count).toBe(1);
  });

  it('respects disabled list', async () => {
    const dir = createTempDir();
    createPlugin(dir, 'blocked');

    const manager = new PluginManager();
    await manager.loadAll([dir], { disabled: ['blocked'] });

    expect(manager.hasPlugins).toBe(false);
  });

  it('respects enabled list', async () => {
    const dir = createTempDir();
    createPlugin(dir, 'allowed');
    createPlugin(dir, 'not-allowed');

    const manager = new PluginManager();
    await manager.loadAll([dir], { enabled: ['allowed'] });

    expect(manager.count).toBe(1);
    const plugins = manager.listPlugins();
    expect(plugins[0]!.name).toBe('allowed');
  });

  it('listPlugins returns info for loaded plugins', async () => {
    const dir = createTempDir();
    createPlugin(dir, 'info-test', '2.0.0');

    const manager = new PluginManager();
    await manager.loadAll([dir]);

    const plugins = manager.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      name: 'info-test',
      version: '2.0.0',
      status: 'loaded',
      commands: ['info-test'],
    });
  });

  it('handles plugins that fail to load', async () => {
    const dir = createTempDir();
    const pluginDir = join(dir, 'broken');
    mkdirSync(pluginDir);
    writeFileSync(join(pluginDir, 'jam-plugin.json'), JSON.stringify({
      name: 'broken', version: '1.0.0', commands: [],
    }));
    // Broken JS that doesn't export register
    writeFileSync(join(pluginDir, 'index.js'), 'export const x = 1;');

    const manager = new PluginManager();
    await manager.loadAll([dir]);

    expect(manager.hasPlugins).toBe(false);
  });

  it('logs plugin loading events when logger provided', async () => {
    const dir = createTempDir();
    createPlugin(dir, 'logged');

    const logs: string[] = [];
    const manager = new PluginManager();
    await manager.loadAll([dir], { log: (msg) => logs.push(msg) });

    expect(logs.some((l) => l.includes('logged'))).toBe(true);
  });
});
