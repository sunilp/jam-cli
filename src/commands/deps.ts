/**
 * `jam deps` — dependency graph analyzer.
 *
 * Detect circular imports, unused exports, orphan files, import hotspots.
 * Pure regex parsing — no AST, instant on large codebases.
 */

import chalk from 'chalk';
import { getWorkspaceRoot } from '../utils/workspace.js';
import { getSourceFiles, buildGraphs, findCycles } from '../analyzers/imports.js';

export interface DepsOptions {
  circular?: boolean;
  orphans?: boolean;
  hotspots?: boolean;
  json?: boolean;
  src?: string;
}

export async function runDeps(options: DepsOptions): Promise<void> {
  let root: string;
  try {
    root = await getWorkspaceRoot();
  } catch {
    process.stderr.write('Not a git repository.\n');
    process.exit(1);
    return;
  }

  const srcDir = options.src ?? '';

  let sourceFiles: string[];
  try {
    sourceFiles = getSourceFiles(root, srcDir || undefined);
  } catch {
    process.stderr.write('Not a git repository.\n');
    process.exit(1);
    return;
  }

  // Build dependency graph
  const { graph, reverseGraph } = buildGraphs(sourceFiles, root);

  const showAll = !options.circular && !options.orphans && !options.hotspots;

  // ── Circular dependencies ──────────────────────────────────────────────
  const cycles = findCycles(graph);

  if (options.circular || showAll) {
    if (options.json && options.circular) {
      process.stdout.write(JSON.stringify({ cycles }, null, 2) + '\n');
      return;
    }

    if (cycles.length === 0) {
      if (!showAll) process.stdout.write(chalk.green('No circular dependencies found.\n'));
    } else {
      process.stdout.write(`\n${chalk.red.bold('Circular Dependencies')} ${chalk.dim(`(${cycles.length})`)}\n\n`);
      for (let i = 0; i < cycles.length; i++) {
        const cycle = cycles[i]!;
        process.stdout.write(`  ${chalk.red(`Cycle ${i + 1}:`)} ${cycle.map((f) => chalk.yellow(f)).join(' → ')} → ${chalk.yellow(cycle[0]!)}\n`);
      }
      process.stdout.write('\n');
    }
  }

  // ── Orphan files (nothing imports them, not entry points) ──────────────
  if (options.orphans || showAll) {
    const entryPatterns = [/index\.[jt]sx?$/, /main\.[jt]sx?$/, /cli\.[jt]sx?$/, /^src\/index/];
    const orphans = sourceFiles.filter((f) => {
      const importers = reverseGraph.get(f)?.size ?? 0;
      if (importers > 0) return false;
      return !entryPatterns.some((p) => p.test(f));
    });

    if (options.json && options.orphans) {
      process.stdout.write(JSON.stringify({ orphans }, null, 2) + '\n');
      return;
    }

    if (orphans.length === 0) {
      if (!showAll) process.stdout.write(chalk.green('No orphan files found.\n'));
    } else {
      process.stdout.write(`\n${chalk.yellow.bold('Orphan Files')} ${chalk.dim(`(imported by nothing — ${orphans.length})`)}\n\n`);
      for (const f of orphans.slice(0, 20)) {
        process.stdout.write(`  ${chalk.dim('○')} ${f}\n`);
      }
      if (orphans.length > 20) process.stdout.write(chalk.dim(`  ... and ${orphans.length - 20} more\n`));
      process.stdout.write('\n');
    }
  }

  // ── Import hotspots (most imported files) ──────────────────────────────
  if (options.hotspots || showAll) {
    const hotspots = sourceFiles
      .map((f) => ({ file: f, importers: reverseGraph.get(f)?.size ?? 0 }))
      .filter((h) => h.importers > 0)
      .sort((a, b) => b.importers - a.importers)
      .slice(0, 15);

    if (options.json && options.hotspots) {
      process.stdout.write(JSON.stringify({ hotspots }, null, 2) + '\n');
      return;
    }

    if (hotspots.length > 0) {
      const max = hotspots[0]!.importers;
      process.stdout.write(`\n${chalk.cyan.bold('Import Hotspots')} ${chalk.dim('(most imported)')}\n\n`);
      for (const h of hotspots) {
        const barLen = Math.max(1, Math.round((h.importers / max) * 20));
        const bar = chalk.cyan('█'.repeat(barLen));
        process.stdout.write(`  ${bar} ${chalk.white(String(h.importers).padStart(3))}  ${h.file}\n`);
      }
      process.stdout.write('\n');
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────
  if (showAll) {
    const totalEdges = Array.from(graph.values()).reduce((s, deps) => s + deps.size, 0);

    if (options.json) {
      const hotspots = sourceFiles
        .map((f) => ({ file: f, importers: reverseGraph.get(f)?.size ?? 0 }))
        .filter((h) => h.importers > 0)
        .sort((a, b) => b.importers - a.importers)
        .slice(0, 15);
      const orphans = sourceFiles.filter((f) => {
        const importers = reverseGraph.get(f)?.size ?? 0;
        return importers === 0 && !/index\.[jt]sx?$/.test(f);
      });
      process.stdout.write(JSON.stringify({
        summary: { files: sourceFiles.length, imports: totalEdges, cycles: cycles.length },
        cycles, orphans, hotspots,
      }, null, 2) + '\n');
      return;
    }

    process.stdout.write(
      chalk.dim(`${sourceFiles.length} files, ${totalEdges} import edges, ${cycles.length} cycles\n\n`),
    );
  }
}
