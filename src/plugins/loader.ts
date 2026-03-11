/**
 * Plugin discovery and loading.
 *
 * Scans directories for subdirectories containing `jam-plugin.json`,
 * validates manifests, and dynamically imports plugin modules.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PluginManifestSchema } from './types.js';
import type { DiscoveredPlugin, PluginModule } from './types.js';

/**
 * Scan a list of directories for plugin subdirectories.
 * Each plugin subdirectory must contain a `jam-plugin.json` manifest.
 * Skips missing directories silently.
 */
export function discoverPlugins(pluginDirs: string[]): DiscoveredPlugin[] {
  const discovered: DiscoveredPlugin[] = [];
  const seen = new Set<string>();

  for (const dir of pluginDirs) {
    if (!existsSync(dir)) continue;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const pluginDir = join(dir, entry);
      const manifestPath = join(pluginDir, 'jam-plugin.json');
      if (!existsSync(manifestPath)) continue;

      try {
        const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        const manifest = PluginManifestSchema.parse(raw);

        // Deduplicate by name (first wins)
        if (seen.has(manifest.name)) continue;
        seen.add(manifest.name);

        // Resolve entry point
        const entryPoint = resolveEntryPoint(pluginDir);
        if (!entryPoint) continue;

        discovered.push({ manifest, directory: pluginDir, entryPoint });
      } catch {
        // Invalid manifest — skip silently, manager will log
      }
    }
  }

  return discovered;
}

/**
 * Resolve the entry point file for a plugin directory.
 * Tries: index.js, index.mjs, index.cjs
 */
function resolveEntryPoint(pluginDir: string): string | null {
  for (const name of ['index.js', 'index.mjs', 'index.cjs']) {
    const p = join(pluginDir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Dynamically import a plugin module and validate it exports `register`.
 */
export async function loadPluginModule(entryPoint: string): Promise<PluginModule> {
  const fileUrl = pathToFileURL(entryPoint).href;
  const mod: unknown = await import(fileUrl);

  const moduleObj = mod as Record<string, unknown>;
  if (typeof moduleObj['register'] !== 'function') {
    throw new Error(`Plugin at ${entryPoint} does not export a 'register' function`);
  }

  return moduleObj as unknown as PluginModule;
}
