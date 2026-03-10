/**
 * `jam mcp list` — show connected MCP servers and their available tools.
 *
 * Displays governance info: group, policy, tool filtering.
 */

import chalk from 'chalk';
import { loadConfig } from '../config/loader.js';
import { createMcpManager } from '../mcp/manager.js';
import { printError } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import type { CliOverrides } from '../config/schema.js';

export interface McpListOptions extends CliOverrides {
  json?: boolean;
}

const POLICY_LABELS: Record<string, string> = {
  auto: chalk.green('auto'),
  ask: chalk.yellow('ask'),
  deny: chalk.red('deny'),
};

export async function runMcpList(options: McpListOptions): Promise<void> {
  try {
    const config = await loadConfig(process.cwd(), options);

    if (!config.mcpServers || Object.keys(config.mcpServers).length === 0) {
      process.stderr.write('No MCP servers configured.\n\n');
      process.stderr.write('Add servers to your .jamrc:\n');
      process.stderr.write(chalk.dim(JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir'],
            group: 'code',
            toolPolicy: 'auto',
          },
        },
        mcpGroups: ['code', 'db'],
      }, null, 2)) + '\n');
      return;
    }

    const log = (msg: string) => process.stderr.write(msg + '\n');
    const manager = await createMcpManager(config.mcpServers, log, config.mcpGroups);

    try {
      const servers = manager.listServers();

      if (options.json) {
        const data = servers.map((s) => ({
          name: s.name,
          serverInfo: s.serverInfo,
          group: s.group ?? null,
          toolPolicy: s.toolPolicy,
          totalTools: s.totalTools,
          filteredTools: s.filteredTools,
          tools: s.tools.map((t) => ({
            name: t.name,
            description: t.description,
          })),
        }));

        // Include skipped servers info
        const allServerNames = Object.keys(config.mcpServers);
        const connectedNames = new Set(servers.map((s) => s.name));
        const skipped = allServerNames
          .filter((n) => !connectedNames.has(n))
          .map((n) => {
            const cfg = config.mcpServers![n]!;
            return {
              name: n,
              reason: cfg.enabled === false
                ? 'disabled'
                : config.mcpGroups?.length
                  ? `group "${cfg.group ?? 'none'}" not active`
                  : 'connection failed',
            };
          });

        process.stdout.write(JSON.stringify({ connected: data, skipped }, null, 2) + '\n');
        return;
      }

      // Show active groups if configured
      if (config.mcpGroups && config.mcpGroups.length > 0) {
        process.stdout.write(`\n${chalk.bold('Active Groups')}: ${config.mcpGroups.map((g) => chalk.cyan(g)).join(', ')}\n`);
      }

      // Show skipped servers
      const allServerNames = Object.keys(config.mcpServers);
      const connectedNames = new Set(servers.map((s) => s.name));
      const skippedNames = allServerNames.filter((n) => !connectedNames.has(n));

      if (skippedNames.length > 0) {
        process.stdout.write(`\n${chalk.dim('Skipped')}: ${skippedNames.map((n) => {
          const cfg = config.mcpServers![n]!;
          const reason = cfg.enabled === false ? 'disabled' : 'group filtered';
          return `${chalk.dim(n)} (${chalk.dim(reason)})`;
        }).join(', ')}\n`);
      }

      if (servers.length === 0) {
        process.stderr.write('\nAll configured servers were skipped or failed to connect.\n');
        return;
      }

      process.stdout.write(`\n${chalk.bold('Connected MCP Servers')}\n\n`);

      for (const server of servers) {
        // Server header with group and policy
        const groupTag = server.group ? ` ${chalk.dim('[')}${chalk.cyan(server.group)}${chalk.dim(']')}` : '';
        const policyTag = ` policy:${POLICY_LABELS[server.toolPolicy] ?? server.toolPolicy}`;
        const filterInfo = server.filteredTools < server.totalTools
          ? ` ${chalk.dim(`(${server.filteredTools}/${server.totalTools} tools exposed)`)}`
          : '';

        process.stdout.write(`${chalk.cyan.bold(server.name)} (${chalk.dim(server.serverInfo)})${groupTag}${policyTag}${filterInfo}\n`);

        if (server.toolPolicy === 'deny') {
          process.stdout.write(`  ${chalk.red('All tools denied by policy')}\n`);
        } else if (server.tools.length === 0) {
          process.stdout.write(`  ${chalk.dim('No tools available')}\n`);
        } else {
          for (const tool of server.tools) {
            process.stdout.write(`  ${chalk.yellow('▸')} ${chalk.bold(tool.name)}`);
            if (tool.description) {
              process.stdout.write(` — ${chalk.dim(tool.description)}`);
            }
            process.stdout.write('\n');
          }
        }
        process.stdout.write('\n');
      }
    } finally {
      await manager.shutdown();
    }
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}
