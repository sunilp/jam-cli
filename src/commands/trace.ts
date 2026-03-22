import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { withRetry } from '../utils/stream.js';
import { streamToStdout, printError, renderMarkdown } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import { ResponseCache, cachedCollect } from '../storage/response-cache.js';
import {
  buildCallGraph,
  formatAsciiTree as formatAsciiTreeLegacy,
  formatMermaid as formatMermaidLegacy,
  formatGraphForAI as formatGraphForAILegacy,
} from '../utils/call-graph.js';
import {
  isTreeSitterAvailable,
  buildIndex,
  traceSymbol,
  analyzeImpact,
  formatAsciiTree as formatAsciiTreeV2,
  formatMermaid as formatMermaidV2,
  formatGraphForAI as formatGraphForAIV2,
  formatImpactReport,
} from '../trace/index.js';
import type { CliOverrides } from '../config/schema.js';
import type { ChalkInstance } from 'chalk';

export interface TraceOptions extends CliOverrides {
  depth?: number;
  noAi?: boolean;
  json?: boolean;
  quiet?: boolean;
  impact?: boolean;
  reindex?: boolean;
  lang?: string;
  mermaid?: boolean;
  dataLineage?: boolean;
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

    // Data lineage stub
    if (options.dataLineage) {
      process.stderr.write('Data lineage is coming in Phase 2\n');
      return;
    }

    const chalk = (await import('chalk')).default;
    const workspaceRoot = await getWorkspaceRoot();
    const write = (msg: string) => process.stderr.write(msg);

    write(`Tracing ${chalk.cyan(symbolName)}...\n\n`);

    // ── Engine selection: v2 (tree-sitter + SQLite) or legacy (regex) ──────
    if (isTreeSitterAvailable()) {
      await runTraceV2(symbolName, options, workspaceRoot, chalk, write);
    } else {
      await runTraceLegacy(symbolName, options, workspaceRoot, chalk, write);
    }
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}

// ── V2 engine (tree-sitter + SQLite index) ────────────────────────────────────

async function runTraceV2(
  symbolName: string,
  options: TraceOptions,
  workspaceRoot: string,
  chalk: ChalkInstance,
  write: (msg: string) => void,
): Promise<void> {
  const indexDir = join(workspaceRoot, '.jam', 'trace-index');
  const depth = options.depth ?? 10;

  // --reindex: delete existing index before building
  if (options.reindex) {
    try {
      rmSync(indexDir, { recursive: true, force: true });
    } catch { /* may not exist */ }
  }

  const store = await buildIndex(workspaceRoot, indexDir, {
    forceReindex: options.reindex,
  });

  try {
    // ── Impact analysis ────────────────────────────────────────────────────
    if (options.impact) {
      const report = analyzeImpact(store, symbolName);
      if (report.symbol.file === '') {
        await printError(
          `Symbol "${symbolName}" not found in the workspace.`,
          'Check the spelling or try --reindex. Run jam trace <symbol> to see candidates.',
        );
        process.exit(1);
      }
      const formatted = formatImpactReport(report);
      process.stdout.write('\n');
      for (const line of formatted.split('\n')) {
        process.stdout.write(`  ${line}\n`);
      }
      process.stdout.write('\n');
      return;
    }

    // ── Trace symbol ───────────────────────────────────────────────────────
    const result = traceSymbol(store, symbolName, { depth });

    if (result.notFound) {
      const errMsg = `Symbol "${symbolName}" not found in the workspace.`;
      let hint = 'Check the spelling, or try --reindex to rebuild the index.';
      if (result.candidates && result.candidates.length > 0) {
        hint += '\n\nDid you mean:';
        for (const c of result.candidates) {
          hint += `\n  - ${c.name} (${c.kind}) in ${c.file}`;
        }
      }
      await printError(errMsg, hint);
      process.exit(1);
    }

    // ── JSON output ────────────────────────────────────────────────────────
    if (options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }

    // ── Mermaid output (only mermaid, not ascii tree) ──────────────────────
    if (options.mermaid) {
      const mermaid = formatMermaidV2(result);
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
      return;
    }

    // ── Default: ASCII tree (only ascii tree, not both) ────────────────────
    const tree = formatAsciiTreeV2(result);
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

    // Stats
    write(chalk.dim(`  ${result.callers.length} call site${result.callers.length !== 1 ? 's' : ''}`));
    write(chalk.dim(` · ${result.imports.length} import${result.imports.length !== 1 ? 's' : ''}`));
    write(chalk.dim(` · ${result.callees.length} outgoing call${result.callees.length !== 1 ? 's' : ''}\n`));
    write('\n');

    // ── AI explanation ───────────────────────────────────────────────────────
    if (!options.noAi) {
      try {
        write(chalk.bold('  AI Analysis\n'));
        write(chalk.dim('  ' + '─'.repeat(60) + '\n'));
        write('\n');

        const config = await loadConfig(process.cwd(), options);
        const profile = getActiveProfile(config);
        const adapter = await createProvider(profile);

        const graphContext = formatGraphForAIV2(result, 8000);
        const prompt = [
          'Here\'s the call graph. Walk through the flow and flag anything that looks off:',
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
          systemPrompt: 'You are Jam, a senior software architect. Be direct, be specific. If something looks wrong, say so.',
        };

        if (config.cacheEnabled) {
          const cache = new ResponseCache(config.cacheTtlSeconds * 1000);
          const aiResult = await cachedCollect(cache, profile.provider, request, () =>
            withRetry(() => adapter.streamCompletion(request))
          );
          if (aiResult.fromCache) write(chalk.dim('  (cached)\n'));
          try {
            const rendered = await renderMarkdown(aiResult.text);
            process.stdout.write(rendered);
          } catch {
            process.stdout.write(aiResult.text + '\n');
          }
        } else {
          await streamToStdout(withRetry(() => adapter.streamCompletion(request)));
        }

        write('\n');
      } catch {
        write(chalk.dim('  AI analysis unavailable — showing structural results only\n\n'));
      }
    }
  } finally {
    store.close();
  }
}

// ── Legacy engine (regex-based call-graph) ────────────────────────────────────

async function runTraceLegacy(
  symbolName: string,
  options: TraceOptions,
  workspaceRoot: string,
  chalk: ChalkInstance,
  write: (msg: string) => void,
): Promise<void> {
  // Build call graph
  const graph = await buildCallGraph(symbolName, workspaceRoot, {
    depth: options.depth ?? 10,
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

  // ── Mermaid output (only mermaid) ───────────────────────────────────────
  if (options.mermaid) {
    const mermaid = formatMermaidLegacy(graph);
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
    return;
  }

  // ── ASCII tree ──────────────────────────────────────────────────────────
  const tree = formatAsciiTreeLegacy(graph);
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

  // Stats
  write(chalk.dim(`  ${graph.callers.length} call site${graph.callers.length !== 1 ? 's' : ''}`));
  write(chalk.dim(` · ${graph.imports.length} import${graph.imports.length !== 1 ? 's' : ''}`));
  write(chalk.dim(` · ${graph.callees.length} outgoing call${graph.callees.length !== 1 ? 's' : ''}\n`));
  write('\n');

  // ── AI explanation ──────────────────────────────────────────────────────
  if (!options.noAi) {
    try {
      write(chalk.bold('  AI Analysis\n'));
      write(chalk.dim('  ' + '─'.repeat(60) + '\n'));
      write('\n');

      const config = await loadConfig(process.cwd(), options);
      const profile = getActiveProfile(config);
      const adapter = await createProvider(profile);

      const graphContext = formatGraphForAILegacy(graph);
      const prompt = [
        'Here\'s the call graph. Walk through the flow and flag anything that looks off:',
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
        const aiResult = await cachedCollect(cache, profile.provider, request, () =>
          withRetry(() => adapter.streamCompletion(request))
        );
        if (aiResult.fromCache) write(chalk.dim('  (cached)\n'));
        try {
          const rendered = await renderMarkdown(aiResult.text);
          process.stdout.write(rendered);
        } catch {
          process.stdout.write(aiResult.text + '\n');
        }
      } else {
        await streamToStdout(withRetry(() => adapter.streamCompletion(request)));
      }

      write('\n');
    } catch {
      write(chalk.dim('  AI analysis unavailable — showing structural results only\n\n'));
    }
  }
}
