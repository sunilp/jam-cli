import { dirname, join, extname } from 'node:path';
import type { AnalyzerPlugin, FileAnalysis } from './base.js';
import type { IntelNode, IntelEdge } from '../types.js';

// Extensions that map to 'typescript' language
const TS_EXTS = new Set(['.ts', '.tsx']);
// Extensions that map to 'javascript' language
const JS_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs']);

// Regex patterns for exported symbols
const SYMBOL_PATTERNS: Array<{ re: RegExp; type: 'class' | 'function' }> = [
  { re: /export\s+(?:default\s+)?class\s+(\w+)/g, type: 'class' },
  { re: /export\s+(?:default\s+)?interface\s+(\w+)/g, type: 'class' },
  { re: /export\s+(?:default\s+)?type\s+(\w+)\s*=/g, type: 'class' },
  { re: /export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/g, type: 'function' },
  { re: /export\s+(?:default\s+)?enum\s+(\w+)/g, type: 'function' },
  { re: /export\s+const\s+(\w+)/g, type: 'function' },
];

// Regex patterns for import extraction (relative only)
const IMPORT_PATTERNS = [
  /(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]/g,
  /(?:import|export)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

// Express route detection
const EXPRESS_ROUTE_RE = /(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/g;

// process.env variable detection
const PROCESS_ENV_RE = /process\.env\.([A-Z_][A-Z0-9_]*)/g;

/**
 * Resolve a relative import path to a best-guess relative file path.
 * Does not touch the filesystem — purely string-based.
 *
 * Strategy:
 *  1. Strip .js → try .ts
 *  2. If no extension, append .ts
 *  3. Everything is kept relative to the project root
 */
function resolveImportPath(rawImport: string, fromFile: string): string {
  // Join the from-file's directory with the raw import
  const fromDir = dirname(fromFile);
  const joined = join(fromDir, rawImport);

  // If .js extension, assume the real file is .ts (ESM convention)
  if (joined.endsWith('.js')) {
    return joined.replace(/\.js$/, '.ts');
  }

  // If .jsx, leave as-is
  if (joined.endsWith('.jsx') || joined.endsWith('.tsx') || joined.endsWith('.ts') || joined.endsWith('.mjs') || joined.endsWith('.cjs')) {
    return joined;
  }

  // No extension: default to .ts
  return joined + '.ts';
}

export class TypeScriptAnalyzer implements AnalyzerPlugin {
  name = 'typescript';
  languages = ['typescript', 'javascript'];
  extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

  analyzeFile(content: string, relPath: string, _rootDir: string): FileAnalysis {
    const nodes: IntelNode[] = [];
    const edges: IntelEdge[] = [];

    const ext = extname(relPath).toLowerCase();
    const language = TS_EXTS.has(ext) ? 'typescript' : JS_EXTS.has(ext) ? 'javascript' : 'javascript';
    const isTsx = ext === '.tsx';
    const fileId = `file:${relPath}`;

    // ── 1. File node ──────────────────────────────────────────────────────
    nodes.push({
      id: fileId,
      type: 'file',
      name: relPath,
      filePath: relPath,
      language,
      metadata: {},
    });

    // ── 2. Exported symbols ───────────────────────────────────────────────
    for (const { re, type } of SYMBOL_PATTERNS) {
      // Reset lastIndex before each use (patterns are module-level with /g)
      const pattern = new RegExp(re.source, re.flags);
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1]!;
        const nodeId = `${type}:${name}`;

        const symbolNode: IntelNode = {
          id: nodeId,
          type,
          name,
          filePath: relPath,
          language,
          metadata: {},
        };

        // React: .tsx exported functions get framework='react'
        if (isTsx && type === 'function') {
          symbolNode.framework = 'react';
        }

        nodes.push(symbolNode);

        // contains edge: file → symbol
        edges.push({
          source: fileId,
          target: nodeId,
          type: 'contains',
        });
      }
    }

    // ── 3. Import edges ───────────────────────────────────────────────────
    for (const patternTemplate of IMPORT_PATTERNS) {
      const pattern = new RegExp(patternTemplate.source, patternTemplate.flags);
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const rawImport = match[1]!;
        // Only relative imports
        if (!rawImport.startsWith('.') && !rawImport.startsWith('/')) continue;

        const resolvedPath = resolveImportPath(rawImport, relPath);
        const targetId = `file:${resolvedPath}`;

        edges.push({
          source: fileId,
          target: targetId,
          type: 'imports',
        });
      }
    }

    // ── 4. Express routes → endpoint nodes ────────────────────────────────
    const expressPattern = new RegExp(EXPRESS_ROUTE_RE.source, EXPRESS_ROUTE_RE.flags);
    let routeMatch: RegExpExecArray | null;
    while ((routeMatch = expressPattern.exec(content)) !== null) {
      const method = routeMatch[1]!.toUpperCase();
      const path = routeMatch[2]!;
      const routeName = `${method} ${path}`;
      const endpointId = `endpoint:${routeName}`;

      nodes.push({
        id: endpointId,
        type: 'endpoint',
        name: routeName,
        filePath: relPath,
        framework: 'express',
        metadata: { method, path },
      });
    }

    // ── 5. process.env → config nodes (deduplicated) ──────────────────────
    const seenEnvVars = new Set<string>();
    const envPattern = new RegExp(PROCESS_ENV_RE.source, PROCESS_ENV_RE.flags);
    let envMatch: RegExpExecArray | null;
    while ((envMatch = envPattern.exec(content)) !== null) {
      const varName = envMatch[1]!;
      if (seenEnvVars.has(varName)) continue;
      seenEnvVars.add(varName);

      nodes.push({
        id: `config:${varName}`,
        type: 'config',
        name: varName,
        filePath: relPath,
        metadata: {},
      });
    }

    return { nodes, edges };
  }
}
