import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { withRetry } from '../utils/stream.js';
import { streamToStdout, printError, renderMarkdown } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import { ResponseCache, cachedCollect } from '../storage/response-cache.js';
import {
  buildCallGraph,
  formatAsciiTree,
  formatMermaid,
  formatGraphForAI,
} from '../utils/call-graph.js';
import type { CliOverrides } from '../config/schema.js';

export interface TraceOptions extends CliOverrides {
  depth?: number;
  noAi?: boolean;
  json?: boolean;
  quiet?: boolean;
}

export async function runTrace(
  symbolName: string | undefined,
  options: TraceOptions,
): Promise<void> {
  try {
    if (!symbolName) {
      await printError('Provide a symbol name. Usage: jam trace <functionName>');
      process.exit(1);
    }

    const chalk = (await import('chalk')).default;
    const workspaceRoot = await getWorkspaceRoot();
    const write = (msg: string) => process.stderr.write(msg);

    write(`Tracing ${chalk.cyan(symbolName)}...\n\n`);

    // Build call graph
    const graph = await buildCallGraph(symbolName, workspaceRoot, {
      depth: options.depth ?? 3,
      callees: true,
    });

    if (graph.symbol.file === '(not found)') {
      await printError(
        `Symbol "${symbolName}" not found in the workspace.`,
        'Check the spelling, or try a different symbol. Only TypeScript/JavaScript/Python files are scanned.',
      );
      process.exit(1);
    }

    // JSON output
    if (options.json) {
      process.stdout.write(JSON.stringify(graph, null, 2) + '\n');
      return;
    }

    // ── ASCII tree ──────────────────────────────────────────────────────────
    const tree = formatAsciiTree(graph);
    process.stdout.write('\n');
    process.stdout.write(chalk.bold('  Call Graph\n'));
    process.stdout.write(chalk.dim('  ' + '─'.repeat(60) + '\n'));
    process.stdout.write('\n');

    // Colorize the tree
    for (const line of tree.split('\n')) {
      if (line.startsWith('  Defined:')) {
        process.stdout.write(chalk.dim(`  ${line}\n`));
      } else if (line.startsWith('  Called from:') || line.startsWith('  Calls into:') ||
                 line.startsWith('  Imported by:') || line.startsWith('  Upstream call chain:')) {
        process.stdout.write(chalk.bold.white(`  ${line}\n`));
      } else if (line.includes('├─') || line.includes('└─') || line.includes('│')) {
        process.stdout.write(chalk.cyan(`  ${line}\n`));
      } else if (line.trim()) {
        process.stdout.write(`  ${line}\n`);
      } else {
        process.stdout.write('\n');
      }
    }

    // ── Mermaid diagram ─────────────────────────────────────────────────────
    const mermaid = formatMermaid(graph);
    process.stdout.write('\n');
    process.stdout.write(chalk.bold('  Mermaid Diagram\n'));
    process.stdout.write(chalk.dim('  ' + '─'.repeat(60) + '\n'));
    process.stdout.write('\n');
    process.stdout.write('  ```mermaid\n');
    for (const line of mermaid.split('\n')) {
      process.stdout.write(`  ${line}\n`);
    }
    process.stdout.write('  ```\n');
    process.stdout.write('\n');

    // Stats
    write(chalk.dim(`  ${graph.callers.length} call site${graph.callers.length !== 1 ? 's' : ''}`));
    write(chalk.dim(` · ${graph.imports.length} import${graph.imports.length !== 1 ? 's' : ''}`));
    write(chalk.dim(` · ${graph.callees.length} outgoing call${graph.callees.length !== 1 ? 's' : ''}\n`));
    write('\n');

    // ── AI explanation ──────────────────────────────────────────────────────
    if (!options.noAi) {
      write(chalk.bold('  AI Analysis\n'));
      write(chalk.dim('  ' + '─'.repeat(60) + '\n'));
      write('\n');

      const config = await loadConfig(process.cwd(), options);
      const profile = getActiveProfile(config);
      const adapter = await createProvider(profile);

      const graphContext = formatGraphForAI(graph);
      const prompt = [
        'Analyze this call graph and explain the flow to a developer:',
        '',
        graphContext,
        '',
        'Provide:',
        '1. **Flow Summary** — A 2-3 sentence overview of what this symbol does and how it fits in the architecture',
        '2. **Data Flow** — How data moves through the call chain (what goes in, what comes out)',
        '3. **Key Observations** — Important patterns, potential issues, or coupling concerns',
        '4. **Dependency Impact** — What would break if this symbol changed',
        '',
        'Be concise and practical. Focus on what a developer needs to know.',
      ].join('\n');

      const request = {
        messages: [{ role: 'user' as const, content: prompt }],
        model: profile.model,
        temperature: profile.temperature ?? 0.3,
        maxTokens: profile.maxTokens ?? 1024,
        systemPrompt: 'You are a senior software architect analyzing a codebase. Be concise and insightful.',
      };

      if (config.cacheEnabled) {
        const cache = new ResponseCache(config.cacheTtlSeconds * 1000);
        const result = await cachedCollect(cache, profile.provider, request, () =>
          withRetry(() => adapter.streamCompletion(request))
        );
        if (result.fromCache) write(chalk.dim('  (cached)\n'));
        try {
          const rendered = await renderMarkdown(result.text);
          process.stdout.write(rendered);
        } catch {
          process.stdout.write(result.text + '\n');
        }
      } else {
        await streamToStdout(withRetry(() => adapter.streamCompletion(request)));
      }

      write('\n');
    }

  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}
