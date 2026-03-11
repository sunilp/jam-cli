/**
 * `jam plugin list` — show installed plugins.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { PluginManager } from '../plugins/manager.js';
import { loadConfig } from '../config/loader.js';
import { getWorkspaceRoot } from '../utils/workspace.js';

export interface PluginListOptions {
  json?: boolean;
}

export async function runPluginList(options: PluginListOptions): Promise<void> {
  const config = await loadConfig(process.cwd());

  const pluginDirs = [
    join(homedir(), '.jam', 'plugins'),
  ];

  try {
    const wsRoot = await getWorkspaceRoot();
    pluginDirs.push(join(wsRoot, '.jam', 'plugins'));
  } catch { /* not in git repo */ }

  if (config.pluginDirs) {
    pluginDirs.push(...config.pluginDirs);
  }

  const manager = new PluginManager();
  await manager.loadAll(pluginDirs, {
    enabled: config.enabledPlugins,
    disabled: config.disabledPlugins,
  });

  const plugins = manager.listPlugins();

  if (options.json) {
    process.stdout.write(JSON.stringify(plugins, null, 2) + '\n');
    return;
  }

  if (plugins.length === 0) {
    process.stdout.write(chalk.dim('No plugins installed.\n\n'));
    process.stdout.write(`${chalk.bold('To create a plugin:')}\n`);
    process.stdout.write(`  1. Create a directory in ${chalk.cyan('~/.jam/plugins/<name>/')}\n`);
    process.stdout.write(`  2. Add a ${chalk.cyan('jam-plugin.json')} manifest\n`);
    process.stdout.write(`  3. Add an ${chalk.cyan('index.js')} that exports a register() function\n\n`);
    process.stdout.write(`${chalk.bold('Example jam-plugin.json:')}\n`);
    process.stdout.write(chalk.dim(JSON.stringify({
      name: 'my-plugin',
      version: '1.0.0',
      description: 'My custom jam plugin',
      commands: ['my-command'],
    }, null, 2) + '\n\n'));
    return;
  }

  process.stdout.write(`\n${chalk.bold('Installed Plugins')} ${chalk.dim(`(${plugins.length})`)}\n\n`);

  for (const plugin of plugins) {
    const statusIcon = plugin.status === 'loaded'
      ? chalk.green('\u2713')
      : chalk.red('\u2717');
    const version = chalk.dim(`v${plugin.version}`);

    process.stdout.write(`  ${statusIcon} ${chalk.bold(plugin.name)} ${version}\n`);
    if (plugin.description) {
      process.stdout.write(`    ${chalk.dim(plugin.description)}\n`);
    }
    if (plugin.commands.length > 0) {
      process.stdout.write(`    Commands: ${plugin.commands.map((c) => chalk.cyan(c)).join(', ')}\n`);
    }
    process.stdout.write(`    ${chalk.dim(plugin.directory)}\n`);
    if (plugin.error) {
      process.stdout.write(`    ${chalk.red(`Error: ${plugin.error}`)}\n`);
    }
    process.stdout.write('\n');
  }

  // Show scanned directories
  const existingDirs = pluginDirs.filter((d) => existsSync(d));
  if (existingDirs.length > 0) {
    process.stdout.write(chalk.dim('Plugin directories:\n'));
    for (const d of existingDirs) {
      process.stdout.write(chalk.dim(`  ${d}\n`));
    }
    process.stdout.write('\n');
  }
}
