/**
 * `jam go` — interactive agent console.
 *
 * Full-featured agent REPL with orchestrator-backed task execution,
 * MCP tool integration, session memory, and slash commands.
 */

import * as readline from 'node:readline';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { Orchestrator } from '../agent/orchestrator.js';
import { createProgressReporter } from '../agent/progress.js';
import { ALL_TOOL_SCHEMAS, executeTool as executeBuiltinTool } from '../tools/all-tools.js';
import { createMcpManager } from '../mcp/manager.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import { JamError } from '../utils/errors.js';
import { renderMarkdown, printError } from '../ui/renderer.js';
import type { CliOverrides } from '../config/schema.js';

export interface GoCommandOptions extends CliOverrides {
  name?: string;
  auto?: boolean;
  workers?: string;
  image?: string[];
  noSandbox?: boolean;
}

export async function runGo(options: GoCommandOptions): Promise<void> {
  try {
    const cliOverrides: CliOverrides = {
      profile: options.profile,
      provider: options.provider,
      model: options.model,
      baseUrl: options.baseUrl,
    };
    const config = await loadConfig(process.cwd(), cliOverrides);
    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);
    const workspaceRoot = await getWorkspaceRoot(process.cwd());

    // MCP setup
    const mcpLog = (msg: string) => process.stderr.write(msg + '\n');
    const mcpManager = await createMcpManager(config.mcpServers, mcpLog, config.mcpGroups);
    const mcpSchemas = mcpManager.getToolSchemas();

    // Merge MCP tool schemas with built-in tools
    const toolSchemas = mcpSchemas.length > 0
      ? [...ALL_TOOL_SCHEMAS, ...mcpSchemas]
      : ALL_TOOL_SCHEMAS;

    // Tool execution bridge: MCP tools routed to mcpManager, built-in tools to executeTool
    const executeTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
      if (mcpManager.isOwnTool(name)) {
        return mcpManager.executeTool(name, args);
      }
      return executeBuiltinTool(name, args, workspaceRoot);
    };

    // Create orchestrator
    const orchestrator = new Orchestrator({
      adapter,
      workspaceRoot,
      toolSchemas,
      executeTool,
    });

    const mode = options.auto
      ? 'auto' as const
      : (config.agent?.defaultMode ?? 'supervised') as 'supervised' | 'auto';
    const maxWorkers = options.workers
      ? parseInt(options.workers, 10)
      : (config.agent?.maxWorkers ?? 3);

    // Print welcome
    process.stderr.write('\njam go — interactive agent console\n');
    process.stderr.write(`Provider: ${profile.provider}, Model: ${profile.model ?? 'default'}\n`);
    process.stderr.write(`Mode: ${mode} | Workers: ${maxWorkers}\n`);
    process.stderr.write('Type a task, or /stop /status /exit\n\n');

    // Interactive readline loop
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      prompt: 'jam> ',
    });

    let currentAbort: AbortController | null = null;

    rl.prompt();

    rl.on('line', async (line) => {
      const input = line.trim();
      if (!input) { rl.prompt(); return; }

      // Handle slash commands
      if (input === '/exit' || input === '/quit') {
        await mcpManager.shutdown();
        rl.close();
        return;
      }

      if (input === '/stop') {
        if (currentAbort) {
          currentAbort.abort();
          process.stderr.write('Stopping current task...\n');
        } else {
          process.stderr.write('No task running.\n');
        }
        rl.prompt();
        return;
      }

      if (input === '/status') {
        process.stderr.write(`Mode: ${mode} | Workers: ${maxWorkers}\n`);
        process.stderr.write(`Provider: ${profile.provider} | Model: ${profile.model ?? 'default'}\n`);
        process.stderr.write(`Workspace: ${workspaceRoot}\n`);
        rl.prompt();
        return;
      }

      if (input === '/help') {
        process.stderr.write('Commands:\n');
        process.stderr.write('  /status  — show current mode, provider, workspace\n');
        process.stderr.write('  /stop    — abort the running task\n');
        process.stderr.write('  /exit    — quit the agent console\n');
        process.stderr.write('  /help    — show this help\n');
        process.stderr.write('\nAnything else is sent as a task to the orchestrator.\n');
        rl.prompt();
        return;
      }

      // Ignore unrecognized slash commands
      if (input.startsWith('/')) {
        process.stderr.write(`Unknown command: ${input}. Type /help for available commands.\n`);
        rl.prompt();
        return;
      }

      // Execute task via orchestrator
      currentAbort = new AbortController();
      const reporter = createProgressReporter({ quiet: false });

      try {
        const result = await orchestrator.execute(input, {
          mode,
          maxWorkers,
          images: options.image,
          signal: currentAbort.signal,
          onProgress: (event) => reporter.onEvent(event),
        });

        // Render result
        if (result.summary) {
          try {
            const rendered = await renderMarkdown(result.summary);
            process.stdout.write(rendered);
          } catch {
            process.stdout.write(result.summary + '\n');
          }
        }

        if (result.filesChanged.length > 0) {
          process.stderr.write(`\nFiles changed: ${result.filesChanged.join(', ')}\n`);
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          process.stderr.write('Task aborted.\n');
        } else {
          const jamErr = JamError.fromUnknown(err);
          process.stderr.write(`Error: ${jamErr.message}\n`);
          if (jamErr.hint) process.stderr.write(`Hint: ${jamErr.hint}\n`);
        }
      } finally {
        currentAbort = null;
      }

      process.stderr.write('\n');
      rl.prompt();
    });

    rl.on('close', () => {
      process.stderr.write('\nBye!\n');
      process.exit(0);
    });

  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}
