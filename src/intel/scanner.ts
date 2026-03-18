// src/intel/scanner.ts

import { readFile, stat, readdir } from 'node:fs/promises';
import { join, relative, extname, basename } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { IntelGraph } from './graph.js';
import { AnalyzerRegistry, createDefaultRegistry } from './analyzers/registry.js';
import { detectFrameworks } from './frameworks/detector.js';

const execAsync = promisify(exec);

/**
 * Check if a directory is a git repository.
 */
async function isGitRepo(rootDir: string): Promise<boolean> {
  try {
    await execAsync('git rev-parse --is-inside-work-tree', { cwd: rootDir });
    return true;
  } catch {
    return false;
  }
}

/**
 * Collect files via git ls-files (respects .gitignore, includes tracked + untracked non-ignored).
 */
async function collectViaGit(rootDir: string): Promise<string[]> {
  const { stdout } = await execAsync(
    'git ls-files --cached --others --exclude-standard',
    { cwd: rootDir },
  );
  return stdout
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

/**
 * Recursively walk a directory and return relative file paths.
 */
async function walkDir(dir: string, rootDir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }
  for (const name of entries) {
    const fullPath = join(dir, name);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(fullPath);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      // Skip common non-source dirs
      if (['.git', 'node_modules', '.jam', 'dist', 'build', '.next', '.cache'].includes(name)) continue;
      const subResults = await walkDir(fullPath, rootDir);
      results.push(...subResults);
    } else if (s.isFile()) {
      results.push(relative(rootDir, fullPath));
    }
  }
  return results;
}

/**
 * Match a relative path against a list of glob-like exclude patterns.
 * Supports simple wildcards: * (no path separator) and ** (any path).
 */
function matchesExcludePattern(relPath: string, pattern: string): boolean {
  // Simple approach: convert pattern to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '@@DOUBLESTAR@@')
    .replace(/\*/g, '[^/]*')
    .replace(/@@DOUBLESTAR@@/g, '.*');
  const re = new RegExp(`^${escaped}$`);
  return re.test(relPath) || re.test(relPath + '/') || relPath.startsWith(pattern.replace(/\*$/, ''));
}

function shouldExclude(relPath: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (matchesExcludePattern(relPath, p)) return true;
    // Also check if any path segment matches
    if (relPath.includes(p)) return true;
  }
  return false;
}

export interface ScanOptions {
  previousGraph?: IntelGraph;
  excludePatterns?: string[];
}

export class Scanner {
  private registry: AnalyzerRegistry;

  constructor(registry?: AnalyzerRegistry) {
    this.registry = registry ?? createDefaultRegistry();
  }

  /**
   * Collect source files from rootDir that have a registered analyzer.
   */
  async collectFiles(rootDir: string, excludePatterns: string[]): Promise<string[]> {
    let relPaths: string[];

    const inGit = await isGitRepo(rootDir);
    if (inGit) {
      relPaths = await collectViaGit(rootDir);
    } else {
      relPaths = await walkDir(rootDir, rootDir);
    }

    // Get the set of extensions and filenames covered by the registry
    const analyzers = this.registry.getAll();
    const knownExts = new Set<string>();
    const knownFilenames = new Set<string>();
    for (const a of analyzers) {
      for (const ext of a.extensions) knownExts.add(ext);
      for (const fn of a.filenames ?? []) knownFilenames.add(fn);
    }

    return relPaths.filter(relPath => {
      if (shouldExclude(relPath, excludePatterns)) return false;

      const fname = basename(relPath);
      if (knownFilenames.has(fname)) return true;

      const ext = extname(fname);
      return ext !== '' && knownExts.has(ext);
    });
  }

  /**
   * Scan the workspace and return an IntelGraph.
   */
  async scan(rootDir: string, options: ScanOptions = {}): Promise<IntelGraph> {
    const { previousGraph, excludePatterns = [] } = options;
    const graph = new IntelGraph();

    // Detect frameworks
    const frameworks = await detectFrameworks(rootDir);
    graph.frameworks = frameworks;

    // Collect files
    const relPaths = await this.collectFiles(rootDir, excludePatterns);

    // Determine the set of languages from all analyzers (for the graph)
    const languageSet = new Set<string>();

    // For incremental scan: build a map of what nodes/edges the previous graph had per file
    const prevMtimes = previousGraph?.mtimes ?? {};

    // (placeholder for analyzeProject accumulation)

    for (const relPath of relPaths) {
      const fullPath = join(rootDir, relPath);

      // Get mtime
      let mtime = 0;
      try {
        const s = await stat(fullPath);
        mtime = s.mtimeMs;
      } catch {
        // file may have been deleted, skip
        continue;
      }
      graph.mtimes[relPath] = mtime;

      // Incremental: if mtime unchanged and previousGraph has this file, copy nodes/edges
      if (previousGraph && prevMtimes[relPath] === mtime) {
        // Copy nodes for this file path
        for (const node of previousGraph.allNodes()) {
          if (node.filePath === relPath) {
            graph.addNode(node);
          }
        }
        // Copy edges that involve nodes from this file
        // We handle this via a post-copy step below
        continue;
      }

      // Fresh analysis
      const analyzer = this.registry.getForFile(relPath);
      if (!analyzer) continue;

      // Track languages
      for (const lang of analyzer.languages) languageSet.add(lang);

      let content: string;
      try {
        content = await readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const { nodes, edges } = analyzer.analyzeFile(content, relPath, rootDir);
      for (const node of nodes) graph.addNode(node);
      for (const edge of edges) graph.addEdge(edge);
    }

    // For incremental: copy edges from previousGraph where both endpoints are in new graph
    if (previousGraph) {
      const newNodeIds = new Set(graph.allNodes().map(n => n.id));
      for (const edge of previousGraph.allEdges()) {
        // Only copy if not already present (simple check: try to avoid dups)
        if (newNodeIds.has(edge.source) && newNodeIds.has(edge.target)) {
          // Check if edge already exists
          const existing = graph.getEdgesFrom(edge.source).find(
            e => e.target === edge.target && e.type === edge.type,
          );
          if (!existing) {
            graph.addEdge(edge);
          }
        }
      }
    }

    // Cross-file analyzeProject passes
    const currentNodes = graph.allNodes();
    const currentEdges = graph.allEdges();

    for (const analyzer of this.registry.getAll()) {
      if (typeof analyzer.analyzeProject === 'function') {
        const result = analyzer.analyzeProject(currentNodes, currentEdges, rootDir);
        for (const node of result.nodes) graph.addNode(node);
        for (const edge of result.edges) graph.addEdge(edge);
        for (const fw of result.frameworks) {
          if (!graph.frameworks.includes(fw)) graph.frameworks.push(fw);
        }
      }
    }

    graph.languages = [...languageSet].sort();

    return graph;
  }
}
