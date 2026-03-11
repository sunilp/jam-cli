/**
 * Project structure analyzer — extract modules, symbols, and metadata.
 */

import { readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { getSourceFiles, buildGraphs, findCycles } from './imports.js';
import type { Graph, ProjectAnalysis, ModuleInfo, SymbolInfo } from './types.js';

/**
 * Extract exported symbols from a TypeScript/JavaScript source file.
 */
export function extractSymbols(content: string, file: string, module: string): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const patterns: Array<{ re: RegExp; kind: SymbolInfo['kind'] }> = [
    { re: /export\s+(?:default\s+)?class\s+(\w+)/g, kind: 'class' },
    { re: /export\s+(?:default\s+)?interface\s+(\w+)/g, kind: 'interface' },
    { re: /export\s+(?:default\s+)?type\s+(\w+)/g, kind: 'type' },
    { re: /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g, kind: 'function' },
    { re: /export\s+(?:default\s+)?enum\s+(\w+)/g, kind: 'enum' },
    { re: /export\s+const\s+(\w+)/g, kind: 'function' }, // treat exported consts as functions
  ];

  for (const { re, kind } of patterns) {
    let match;
    while ((match = re.exec(content)) !== null) {
      symbols.push({ name: match[1]!, kind, file, module, exported: true });
    }
  }

  return symbols;
}

/**
 * Identify entry points (index files, main files, CLI files, bin entries).
 */
function identifyEntryPoints(sourceFiles: string[]): string[] {
  const entryPatterns = [/index\.[jt]sx?$/, /main\.[jt]sx?$/, /cli\.[jt]sx?$/, /^src\/index/];
  return sourceFiles.filter((f) => entryPatterns.some((p) => p.test(f)));
}

/**
 * Group files into logical modules based on directory structure.
 */
function groupIntoModules(sourceFiles: string[], root: string): ModuleInfo[] {
  const moduleMap = new Map<string, string[]>();

  for (const file of sourceFiles) {
    // Use the first meaningful directory as module name
    const parts = file.split('/');
    let moduleName: string;

    if (parts.length <= 1) {
      moduleName = 'root';
    } else if (parts[0] === 'src' && parts.length > 2) {
      moduleName = parts[1]!;
    } else if (parts[0] === 'src') {
      moduleName = 'root';
    } else {
      moduleName = parts[0]!;
    }

    if (!moduleMap.has(moduleName)) moduleMap.set(moduleName, []);
    moduleMap.get(moduleName)!.push(file);
  }

  const modules: ModuleInfo[] = [];
  for (const [name, files] of moduleMap) {
    const symbols: string[] = [];
    for (const file of files) {
      try {
        const content = readFileSync(join(root, file), 'utf-8');
        const fileSymbols = extractSymbols(content, file, name);
        symbols.push(...fileSymbols.map((s) => s.name));
      } catch { /* skip */ }
    }

    const firstFile = files[0]!;
    const directory = files.length === 1
      ? dirname(firstFile)
      : dirname(firstFile).split('/').slice(0, 2).join('/');

    modules.push({
      name,
      directory,
      fileCount: files.length,
      files,
      exportedSymbols: [...new Set(symbols)].slice(0, 20), // cap for prompt size
    });
  }

  return modules.sort((a, b) => b.fileCount - a.fileCount);
}

/**
 * Compute inter-module dependency edges.
 */
function computeInterModuleDeps(
  graph: Graph, sourceFiles: string[],
): Array<{ from: string; to: string; weight: number }> {
  const fileToModule = new Map<string, string>();
  for (const file of sourceFiles) {
    const parts = file.split('/');
    if (parts[0] === 'src' && parts.length > 2) {
      fileToModule.set(file, parts[1]!);
    } else if (parts.length > 1 && parts[0] !== 'src') {
      fileToModule.set(file, parts[0]!);
    } else {
      fileToModule.set(file, 'root');
    }
  }

  const edgeWeights = new Map<string, number>();
  for (const [file, deps] of graph) {
    const fromMod = fileToModule.get(file) ?? 'root';
    for (const dep of deps) {
      const toMod = fileToModule.get(dep) ?? 'root';
      if (fromMod !== toMod) {
        const key = `${fromMod}->${toMod}`;
        edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
      }
    }
  }

  return Array.from(edgeWeights.entries())
    .map(([key, weight]) => {
      const [from, to] = key.split('->');
      return { from: from!, to: to!, weight };
    })
    .sort((a, b) => b.weight - a.weight);
}

/**
 * Detect the project name from package.json.
 */
function getProjectName(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { name?: string };
    return pkg.name ?? basename(root);
  } catch {
    return basename(root);
  }
}

/**
 * Full project analysis: structure, dependencies, symbols, cycles, hotspots.
 */
export function analyzeProject(
  root: string,
  options?: { srcDir?: string; exclude?: string[] },
): ProjectAnalysis {
  const srcDir = options?.srcDir;
  let sourceFiles = getSourceFiles(root, srcDir);

  // Apply exclude filters
  if (options?.exclude && options.exclude.length > 0) {
    sourceFiles = sourceFiles.filter((f) =>
      !options.exclude!.some((ex) => f.startsWith(ex) || f.includes(`/${ex}/`)),
    );
  }

  const { graph, reverseGraph } = buildGraphs(sourceFiles, root);
  const cycles = findCycles(graph);
  const modules = groupIntoModules(sourceFiles, root);
  const interModuleDeps = computeInterModuleDeps(graph, sourceFiles);

  const hotspots = sourceFiles
    .map((f) => ({ file: f, importers: reverseGraph.get(f)?.size ?? 0 }))
    .filter((h) => h.importers > 0)
    .sort((a, b) => b.importers - a.importers)
    .slice(0, 15);

  const entryPoints = identifyEntryPoints(sourceFiles);
  const totalEdges = Array.from(graph.values()).reduce((s, deps) => s + deps.size, 0);

  // Collect all symbols
  const symbols: SymbolInfo[] = [];
  for (const mod of modules) {
    for (const file of mod.files) {
      try {
        const content = readFileSync(join(root, file), 'utf-8');
        symbols.push(...extractSymbols(content, file, mod.name));
      } catch { /* skip */ }
    }
  }

  return {
    name: getProjectName(root),
    rootDir: root,
    entryPoints,
    modules,
    interModuleDeps,
    cycles,
    hotspots,
    symbols: symbols.slice(0, 100), // cap for prompt size
    fileCount: sourceFiles.length,
    importCount: totalEdges,
  };
}
