/**
 * Import graph analysis — shared between jam deps and jam diagram.
 *
 * Pure regex parsing — no AST, instant on large codebases.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { execSync } from 'node:child_process';
import type { Graph } from './types.js';

export const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/**
 * Extract import paths from a source file using regex.
 * Handles: import ... from '...', require('...'), dynamic import('...')
 */
export function extractImports(content: string): string[] {
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
export function resolveImport(importPath: string, fromFile: string, root: string): string | null {
  const dir = dirname(join(root, fromFile));
  const base = join(dir, importPath);
  const rel = (p: string) => relative(root, p);

  if (existsSync(base) && !statIsDir(base)) return rel(base);

  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs']) {
    const withExt = base + ext;
    if (existsSync(withExt)) return rel(withExt);
  }

  if (importPath.endsWith('.js')) {
    const tsPath = base.replace(/\.js$/, '.ts');
    if (existsSync(tsPath)) return rel(tsPath);
    const tsxPath = base.replace(/\.js$/, '.tsx');
    if (existsSync(tsxPath)) return rel(tsxPath);
  }

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
export function findCycles(graph: Graph): string[][] {
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

/**
 * Get source files from git, filtering by extension and excluding
 * test files, declarations, node_modules, and dist.
 */
export function getSourceFiles(root: string, srcDir?: string): string[] {
  const files = execSync('git ls-files --cached --others --exclude-standard', {
    cwd: root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
  }).trim().split('\n').filter(Boolean);

  return files.filter((f) => {
    if (srcDir && !f.startsWith(srcDir)) return false;
    const ext = extname(f).toLowerCase();
    return CODE_EXTS.has(ext) && !f.includes('node_modules/') && !f.includes('dist/') &&
      !f.endsWith('.test.ts') && !f.endsWith('.test.tsx') &&
      !f.endsWith('.spec.ts') && !f.endsWith('.spec.tsx') &&
      !f.endsWith('.d.ts');
  });
}

/**
 * Build forward and reverse dependency graphs from source files.
 */
export function buildGraphs(
  sourceFiles: string[], root: string,
): { graph: Graph; reverseGraph: Graph } {
  const graph: Graph = new Map();
  const reverseGraph: Graph = new Map();

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
    } catch { /* skip unreadable files */ }
  }

  return { graph, reverseGraph };
}
