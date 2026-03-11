/**
 * Plugin manager — lifecycle management for user plugins.
 *
 * Discovers, loads, and registers plugins with Commander.
 * Non-fatal: broken plugins are logged and skipped.
 */

import type { Command } from 'commander';
import { discoverPlugins, loadPluginModule } from './loader.js';
import type { LoadedPlugin, PluginContext, PluginInfo } from './types.js';

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private errors = new Map<string, string>();

  /**
   * Discover and load all plugins from the given directories.
   * Respects enable/disable lists. Non-fatal — logs errors and continues.
   */
  async loadAll(
    pluginDirs: string[],
    options?: {
      enabled?: string[];
      disabled?: string[];
      log?: (msg: string) => void;
    },
  ): Promise<void> {
    const { enabled, disabled, log } = options ?? {};
    const discovered = discoverPlugins(pluginDirs);

    for (const plugin of discovered) {
      const { name } = plugin.manifest;

      // Allowlist: if set, only load plugins in the list
      if (enabled && enabled.length > 0 && !enabled.includes(name)) {
        log?.(`Plugin: skipping "${name}" (not in enabledPlugins)`);
        continue;
      }

      // Denylist: never load plugins in the list
      if (disabled && disabled.includes(name)) {
        log?.(`Plugin: skipping "${name}" (in disabledPlugins)`);
        continue;
      }

      try {
        const module = await loadPluginModule(plugin.entryPoint);
        this.plugins.set(name, { ...plugin, module });
        log?.(`Plugin: loaded "${name}" v${plugin.manifest.version} (${plugin.manifest.commands.join(', ') || 'no commands declared'})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.set(name, msg);
        log?.(`Plugin: failed to load "${name}": ${msg}`);
      }
    }
  }

  /**
   * Register all loaded plugins with the Commander program.
   * Detects command name conflicts with built-in commands.
   */
  async registerAll(
    program: Command,
    context: PluginContext,
    log?: (msg: string) => void,
  ): Promise<void> {
    // Collect existing command names to detect conflicts
    const existingCommands = new Set(program.commands.map((c) => c.name()));

    for (const [name, plugin] of this.plugins) {
      // Check for command name conflicts
      for (const cmdName of plugin.manifest.commands) {
        if (existingCommands.has(cmdName)) {
          log?.(`Plugin: "${name}" skipped command "${cmdName}" (conflicts with built-in)`);
        }
      }

      try {
        await plugin.module.register(program, context);
        log?.(`Plugin: registered "${name}"`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.set(name, msg);
        log?.(`Plugin: failed to register "${name}": ${msg}`);
      }
    }
  }

  /** List all plugins with their status. */
  listPlugins(): PluginInfo[] {
    const result: PluginInfo[] = [];

    for (const [name, plugin] of this.plugins) {
      result.push({
        name,
        version: plugin.manifest.version,
        description: plugin.manifest.description,
        directory: plugin.directory,
        commands: plugin.manifest.commands,
        status: this.errors.has(name) ? 'error' : 'loaded',
        error: this.errors.get(name),
      });
    }

    // Also include plugins that failed to load
    for (const [name, error] of this.errors) {
      if (!this.plugins.has(name)) {
        result.push({
          name,
          version: '?',
          directory: '?',
          commands: [],
          status: 'error',
          error,
        });
      }
    }

    return result;
  }

  /** True if any plugins were loaded. */
  get hasPlugins(): boolean {
    return this.plugins.size > 0;
  }

  /** Number of loaded plugins. */
  get count(): number {
    return this.plugins.size;
  }
}
