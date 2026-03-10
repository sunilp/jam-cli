/**
 * `jam deps` — dependency graph analyzer.
 *
 * Detect circular imports, unused exports, orphan files, import hotspots.
 * Pure regex parsing — no AST, instant on large codebases.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import chalk from 'chalk';
import { getWorkspaceRoot } from '../utils/workspace.js';

type Graph = Map<string, Set<string>>;

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Extract import paths from a source file using regex.
 * Handles: import ... from '...', require('...'), dynamic import('...')
 */
function extractImports(content: string): string[] {
  const imports: string[] = [];
  const patterns = [
    /(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]/g,
    /(?:import|export)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const importPath = match[1]!;
      // Only relative imports (skip node_modules, built-ins)
      if (importPath.startsWith('.')) {
        imports.push(importPath);
      }
    }
  }
  return imports;
}

/**
 * Resolve an import path to an actual file.
 * Handles: .ts/.js extension, index files, .js → .ts mapping.
 */
function resolveImport(importPath: string, fromFile: string, root: string): string | null {
  const dir = dirname(join(root, fromFile));
  const base = join(dir, importPath);
  const rel = (p: string) => relative(root, p);

  // Try direct match
  if (existsSync(base) && !statIsDir(base)) return rel(base);

  // Try with extensions
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs']) {
    const withExt = base + ext;
    if (existsSync(withExt)) return rel(withExt);
  }

  // .js → .ts mapping (common in ESM TypeScript)
  if (importPath.endsWith('.js')) {
    const tsPath = base.replace(/\.js$/, '.ts');
    if (existsSync(tsPath)) return rel(tsPath);
    const tsxPath = base.replace(/\.js$/, '.tsx');
    if (existsSync(tsxPath)) return rel(tsxPath);
  }

  // Try index files
  for (const idx of ['index.ts', 'index.tsx', 'index.js', 'index.jsx']) {
    const indexPath = join(base, idx);
    if (existsSync(indexPath)) return rel(indexPath);
  }

  return null;
}

function statIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch { return false; }
}

/** Tarjan's algorithm for strongly connected components (cycle detection). */
function findCycles(graph: Graph): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const cycles: string[][] = [];

  function strongConnect(v: string) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of graph.get(v) ?? []) {
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);

      // Only report cycles (components with >1 node, or self-loops)
      if (component.length > 1) {
        cycles.push(component.reverse());
      } else if (graph.get(v)?.has(v)) {
        cycles.push([v]);
      }
    }
  }

  for (const node of graph.keys()) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }

  return cycles;
}

export interface DepsOptions {
  circular?: boolean;
  orphans?: boolean;
  hotspots?: boolean;
  json?: boolean;
  src?: string;
}

export async function runDeps(options: DepsOptions): Promise<void> {
  const root = await getWorkspaceRoot();
  const srcDir = options.src ?? '';

  // Get all source files
  let files: string[];
  try {
    files = execSync('git ls-files --cached --others --exclude-standard', {
      cwd: root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
    }).trim().split('\n').filter(Boolean);
  } catch {
    process.stderr.write('Not a git repository.\n');
    process.exit(1);
    return;
  }

  const sourceFiles = files.filter((f) => {
    if (srcDir && !f.startsWith(srcDir)) return false;
    const ext = extname(f).toLowerCase();
    return CODE_EXTS.has(ext) && !f.includes('node_modules/') && !f.includes('dist/') &&
      !f.endsWith('.test.ts') && !f.endsWith('.test.tsx') &&
      !f.endsWith('.spec.ts') && !f.endsWith('.spec.tsx') &&
      !f.endsWith('.d.ts');
  });

  // Build dependency graph
  const graph: Graph = new Map();
  const reverseGraph: Graph = new Map(); // Who imports this file?

  for (const file of sourceFiles) {
    if (!graph.has(file)) graph.set(file, new Set());
    if (!reverseGraph.has(file)) reverseGraph.set(file, new Set());
  }

  for (const file of sourceFiles) {
    try {
      const content = readFileSync(join(root, file), 'utf-8');
      const imports = extractImports(content);

      for (const imp of imports) {
        const resolved = resolveImport(imp, file, root);
        if (resolved && sourceFiles.includes(resolved)) {
          graph.get(file)!.add(resolved);
          if (!reverseGraph.has(resolved)) reverseGraph.set(resolved, new Set());
          reverseGraph.get(resolved)!.add(file);
        }
      }
    } catch { /* skip */ }
  }

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
    // Heuristic entry points: index files, main files, CLI files
    const entryPatterns = [/index\.[jt]sx?$/, /main\.[jt]sx?$/, /cli\.[jt]sx?$/, /^src\/index/];
    const orphans = sourceFiles.filter((f) => {
      const importers = reverseGraph.get(f)?.size ?? 0;
      if (importers > 0) return false;
      // Don't flag entry points as orphans
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
