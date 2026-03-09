/**
 * Call-graph builder — traces function/symbol references across a workspace.
 *
 * Uses regex-based extraction (no AST) to find:
 *   1. Definition site of a symbol
 *   2. All call/reference sites (who calls it, with what arguments)
 *   3. Import chains (which files import it)
 *   4. Outgoing calls from the symbol's body
 *
 * Produces a structured graph that can be rendered as text, Mermaid, or JSON.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, extname, relative } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SymbolDefinition {
  name: string;
  kind: 'function' | 'class' | 'method' | 'const' | 'type' | 'interface' | 'variable';
  file: string;
  line: number;
  /** Extracted parameter signature (e.g. "(profile: Profile)") */
  params: string;
  /** Extracted return type if visible */
  returnType: string;
  /** The full body of the function/class (for outgoing call analysis) */
  body: string;
}

export interface CallSite {
  /** File where the call occurs */
  file: string;
  /** Line number */
  line: number;
  /** The full line of code (trimmed) */
  code: string;
  /** Extracted arguments passed at this call site */
  args: string;
}

export interface ImportRef {
  /** File that imports the symbol */
  file: string;
  line: number;
  /** The import statement */
  code: string;
}

export interface OutgoingCall {
  /** Name of the function/symbol being called */
  name: string;
  /** File where the call target is likely defined (if resolved) */
  targetFile: string | null;
  /** Line within the traced symbol's body */
  line: number;
  /** Arguments passed */
  args: string;
}

export interface CallGraph {
  /** The traced symbol */
  symbol: SymbolDefinition;
  /** Files that import this symbol */
  imports: ImportRef[];
  /** All call sites (inbound — who calls this symbol) */
  callers: CallSite[];
  /** Outgoing calls from this symbol's body */
  callees: OutgoingCall[];
  /** Recursive upstream callers (callers of callers), up to depth */
  upstreamChain: UpstreamNode[];
}

export interface UpstreamNode {
  name: string;
  file: string;
  line: number;
  callers: UpstreamNode[];
}

// ── File scanning ────────────────────────────────────────────────────────────

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.jam', 'coverage',
  '__pycache__', '.next', '.nuxt', 'target', 'out', '.venv', 'venv',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java',
]);

async function collectFiles(
  dir: string,
  rootDir: string,
  files: string[] = [],
  maxFiles = 1000,
): Promise<string[]> {
  if (files.length >= maxFiles) return files;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (files.length >= maxFiles) break;
    const name = String(entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(name) && !name.startsWith('.')) {
        await collectFiles(join(dir, name), rootDir, files, maxFiles);
      }
    } else if (CODE_EXTENSIONS.has(extname(name))) {
      files.push(join(dir, name));
    }
  }
  return files;
}

// ── Symbol definition finder ─────────────────────────────────────────────────

/**
 * Find the definition of a symbol across all source files.
 * Collects all candidates and returns the best match
 * (exported function/class > non-exported > method > const).
 */
export async function findDefinition(
  symbolName: string,
  workspaceRoot: string,
): Promise<SymbolDefinition | null> {
  const files = await collectFiles(workspaceRoot, workspaceRoot);
  const candidates: Array<SymbolDefinition & { priority: number }> = [];
  const escaped = escapeRegex(symbolName);

  for (const absPath of files) {
    let content: string;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch {
      continue;
    }

    const relPath = relative(workspaceRoot, absPath);
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // export function symbolName(
      if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${escaped}\\s*\\(`).test(line)) {
        const { params, returnType, body } = extractFunctionDetails(lines, i);
        candidates.push({ name: symbolName, kind: 'function', file: relPath, line: i + 1, params, returnType, body, priority: 10 });
        continue;
      }

      // function symbolName( (non-exported)
      if (new RegExp(`^(?:async\\s+)?function\\s+${escaped}\\s*\\(`).test(line)) {
        const { params, returnType, body } = extractFunctionDetails(lines, i);
        candidates.push({ name: symbolName, kind: 'function', file: relPath, line: i + 1, params, returnType, body, priority: 8 });
        continue;
      }

      // export class / class
      if (new RegExp(`(?:export\\s+)?(?:abstract\\s+)?class\\s+${escaped}\\b`).test(line)) {
        const isExported = line.includes('export');
        const body = extractBlockBody(lines, i);
        candidates.push({ name: symbolName, kind: 'class', file: relPath, line: i + 1, params: '', returnType: '', body, priority: isExported ? 10 : 8 });
        continue;
      }

      // export interface / export type
      if (new RegExp(`export\\s+(?:interface|type)\\s+${escaped}\\b`).test(line)) {
        const kind = line.includes('interface') ? 'interface' as const : 'type' as const;
        const body = extractBlockBody(lines, i);
        candidates.push({ name: symbolName, kind, file: relPath, line: i + 1, params: '', returnType: '', body, priority: 9 });
        continue;
      }

      // export const symbolName = or const symbolName =
      if (new RegExp(`(?:export\\s+)?const\\s+${escaped}\\s*[=:]`).test(line)) {
        const isExported = line.includes('export');
        const isArrow = line.includes('=>') || (lines[i + 1] && lines[i + 1]!.includes('=>'));
        const kind = isArrow ? 'function' as const : 'const' as const;
        const details = isArrow ? extractArrowDetails(lines, i) : { params: '', returnType: '', body: line };
        candidates.push({ name: symbolName, kind, file: relPath, line: i + 1, ...details, priority: isExported ? 7 : 5 });
        continue;
      }

      // Method declaration within a class body (indented, followed by { or :)
      const methodMatch = line.match(
        new RegExp(`^\\s+(?:async\\s+)?${escaped}\\s*\\(`)
      );
      if (methodMatch && !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
        // Only treat as method if the line or next line contains { (actual declaration)
        const nextLine = lines[i + 1] ?? '';
        if (line.includes('{') || line.includes('):') || nextLine.trim().startsWith('{')) {
          const { params, returnType, body } = extractFunctionDetails(lines, i);
          candidates.push({ name: symbolName, kind: 'method', file: relPath, line: i + 1, params, returnType, body, priority: 6 });
        }
      }
    }
  }

  if (candidates.length === 0) return null;

  // Return highest priority candidate
  candidates.sort((a, b) => b.priority - a.priority);
  const best = candidates[0]!;
  return { name: best.name, kind: best.kind, file: best.file, line: best.line, params: best.params, returnType: best.returnType, body: best.body };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract function params, return type, and body from lines starting at the function declaration.
 */
function extractFunctionDetails(lines: string[], startIdx: number): { params: string; returnType: string; body: string } {
  // Gather lines until we find the opening brace
  let combined = '';
  let braceStart = -1;
  for (let j = startIdx; j < Math.min(startIdx + 10, lines.length); j++) {
    combined += lines[j] + '\n';
    if (lines[j]!.includes('{')) {
      braceStart = j;
      break;
    }
  }

  // Extract params between ( and )
  const paramsMatch = combined.match(/\(([^)]*)\)/);
  const params = paramsMatch ? `(${paramsMatch[1]!.trim()})` : '()';

  // Extract return type between ) and {
  const returnMatch = combined.match(/\)\s*:\s*([^{]+)/);
  const returnType = returnMatch ? returnMatch[1]!.trim() : '';

  // Extract body
  const body = braceStart >= 0 ? extractBlockBody(lines, braceStart) : '';

  return { params, returnType, body };
}

function extractArrowDetails(lines: string[], startIdx: number): { params: string; returnType: string; body: string } {
  let combined = '';
  for (let j = startIdx; j < Math.min(startIdx + 10, lines.length); j++) {
    combined += lines[j] + '\n';
    if (lines[j]!.includes('=>')) break;
  }

  const paramsMatch = combined.match(/\(([^)]*)\)/);
  const params = paramsMatch ? `(${paramsMatch[1]!.trim()})` : '()';

  const returnMatch = combined.match(/\)\s*:\s*([^=]+?)=>/);
  const returnType = returnMatch ? returnMatch[1]!.trim() : '';

  const bodyStart = lines.findIndex((l, idx) => idx >= startIdx && (l.includes('{') || l.includes('=>')));
  const body = bodyStart >= 0 ? extractBlockBody(lines, bodyStart) : '';

  return { params, returnType, body };
}

/**
 * Extract a brace-delimited block body starting from a line containing '{'.
 * Limits to 150 lines to avoid capturing huge blocks.
 */
function extractBlockBody(lines: string[], startIdx: number): string {
  const MAX_BODY_LINES = 150;
  let depth = 0;
  let started = false;
  const bodyLines: string[] = [];

  for (let j = startIdx; j < Math.min(startIdx + MAX_BODY_LINES, lines.length); j++) {
    const line = lines[j]!;
    bodyLines.push(line);

    for (const ch of line) {
      if (ch === '{') { depth++; started = true; }
      if (ch === '}') depth--;
    }

    if (started && depth <= 0) break;
  }

  return bodyLines.join('\n');
}

// ── Call site finder ─────────────────────────────────────────────────────────

/**
 * Find all call sites and import references for a symbol.
 */
export async function findReferences(
  symbolName: string,
  definitionFile: string | null,
  workspaceRoot: string,
): Promise<{ callers: CallSite[]; imports: ImportRef[] }> {
  const files = await collectFiles(workspaceRoot, workspaceRoot);
  const callers: CallSite[] = [];
  const imports: ImportRef[] = [];
  const escaped = escapeRegex(symbolName);

  // Patterns for call sites
  const callPattern = new RegExp(`\\b${escaped}\\s*\\(`);
  // Patterns for imports
  const importPattern = new RegExp(`(?:import|from).*\\b${escaped}\\b`);
  // Patterns for new ClassName(
  const newPattern = new RegExp(`new\\s+${escaped}\\s*\\(`);

  for (const absPath of files) {
    let content: string;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch {
      continue;
    }

    const relPath = relative(workspaceRoot, absPath);

    // Skip the definition file for call-site analysis of imports
    const isDefFile = relPath === definitionFile;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();

      // Skip comments
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

      // Import reference
      if (importPattern.test(line) && !isDefFile) {
        imports.push({ file: relPath, line: i + 1, code: trimmed });
        continue;
      }

      // Skip the definition line itself
      if (isDefFile && (
        line.match(new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}`)) ||
        line.match(new RegExp(`(?:export\\s+)?(?:const|class|interface|type)\\s+${escaped}`))
      )) {
        continue;
      }

      // Call site: symbolName( or new SymbolName(
      if (callPattern.test(line) || newPattern.test(line)) {
        // Extract the arguments passed
        const argsMatch = line.match(new RegExp(`(?:new\\s+)?${escaped}\\s*\\(([^)]*)`));
        const args = argsMatch ? argsMatch[1]!.trim() : '';
        callers.push({ file: relPath, line: i + 1, code: trimmed, args });
      }
    }
  }

  return { callers, imports };
}

// ── Outgoing call extractor ──────────────────────────────────────────────────

/**
 * Extract function calls made from within a symbol's body.
 */
export function extractOutgoingCalls(
  body: string,
  symbolName: string,
  knownSymbols: Set<string>,
): OutgoingCall[] {
  const calls: OutgoingCall[] = [];
  const seen = new Set<string>();
  const lines = body.split('\n');

  // Match function calls: word( or word.word(
  const callRegex = /\b([a-zA-Z_]\w*)\s*\(/g;
  // Match await expressions
  const awaitCallRegex = /await\s+([a-zA-Z_]\w*(?:\.\w+)*)\s*\(/g;

  const builtins = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'throw',
    'new', 'typeof', 'instanceof', 'void', 'delete', 'import',
    'require', 'console', 'process', 'Math', 'JSON', 'Object',
    'Array', 'String', 'Number', 'Boolean', 'Promise', 'Date',
    'Map', 'Set', 'RegExp', 'Error', 'Buffer', 'setTimeout',
    'setInterval', 'clearTimeout', 'clearInterval', 'parseInt',
    'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
  ]);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    // Standard function calls
    let match: RegExpExecArray | null;
    callRegex.lastIndex = 0;
    while ((match = callRegex.exec(line)) !== null) {
      const name = match[1]!;
      if (name === symbolName || builtins.has(name) || seen.has(name)) continue;
      seen.add(name);
      const argsMatch = line.slice(match.index).match(/\(([^)]*)/);
      calls.push({
        name,
        targetFile: null,
        line: i + 1,
        args: argsMatch ? argsMatch[1]!.trim() : '',
      });
    }

    // Await calls: await someFunction(
    awaitCallRegex.lastIndex = 0;
    while ((match = awaitCallRegex.exec(line)) !== null) {
      const fullName = match[1]!;
      const parts = fullName.split('.');
      const name = parts[parts.length - 1]!;
      if (name === symbolName || builtins.has(name) || seen.has(name)) continue;
      seen.add(name);
      const argsMatch = line.slice(match.index).match(/\(([^)]*)/);
      calls.push({
        name,
        targetFile: null,
        line: i + 1,
        args: argsMatch ? argsMatch[1]!.trim() : '',
      });
    }
  }

  // Mark calls that match known workspace symbols
  for (const call of calls) {
    if (knownSymbols.has(call.name)) {
      call.targetFile = '(workspace)';
    }
  }

  return calls;
}

// ── Upstream chain builder ───────────────────────────────────────────────────

/**
 * Build recursive upstream caller chain up to a given depth.
 */
export async function buildUpstreamChain(
  symbolName: string,
  workspaceRoot: string,
  maxDepth: number,
  visited: Set<string> = new Set(),
): Promise<UpstreamNode[]> {
  if (maxDepth <= 0 || visited.has(symbolName)) return [];
  visited.add(symbolName);

  const def = await findDefinition(symbolName, workspaceRoot);
  if (!def) return [];

  const { callers } = await findReferences(symbolName, def.file, workspaceRoot);

  // Deduplicate callers by extracting the caller function name
  const callerFunctions = new Map<string, { file: string; line: number }>();
  for (const caller of callers) {
    // Try to determine which function this call site is in
    const callerName = await resolveCallerFunction(caller.file, caller.line, workspaceRoot);
    if (callerName && callerName !== symbolName && !callerFunctions.has(callerName)) {
      callerFunctions.set(callerName, { file: caller.file, line: caller.line });
    }
  }

  const nodes: UpstreamNode[] = [];
  for (const [name, info] of callerFunctions) {
    const subCallers = await buildUpstreamChain(name, workspaceRoot, maxDepth - 1, visited);
    nodes.push({ name, file: info.file, line: info.line, callers: subCallers });
  }

  return nodes;
}

/**
 * Given a file and line number, find the enclosing function/method name.
 */
async function resolveCallerFunction(
  relFile: string,
  line: number,
  workspaceRoot: string,
): Promise<string | null> {
  let content: string;
  try {
    content = await readFile(join(workspaceRoot, relFile), 'utf-8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  // Walk backwards from the call site to find the enclosing function
  const funcPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
  const methodPattern = /^\s+(?:async\s+)?(\w+)\s*\(/;
  const arrowPattern = /(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/;

  for (let i = line - 1; i >= 0; i--) {
    const l = lines[i]!;
    const funcMatch = l.match(funcPattern);
    if (funcMatch) return funcMatch[1]!;
    const methodMatch = l.match(methodPattern);
    if (methodMatch && !l.trim().startsWith('//') && !l.trim().startsWith('*')) {
      // Verify it's a function-like declaration (has a brace or arrow)
      const next = lines[i + 1] ?? '';
      if (l.includes('{') || l.includes('=>') || next.includes('{')) {
        return methodMatch[1]!;
      }
    }
    const arrowMatch = l.match(arrowPattern);
    if (arrowMatch) return arrowMatch[1]!;
  }

  return null;
}

// ── Full graph builder ───────────────────────────────────────────────────────

export interface TraceOptions {
  /** Max depth for upstream chain traversal (default: 3) */
  depth?: number;
  /** Include outgoing calls (default: true) */
  callees?: boolean;
}

/**
 * Build a complete call graph for a symbol.
 */
export async function buildCallGraph(
  symbolName: string,
  workspaceRoot: string,
  options: TraceOptions = {},
): Promise<CallGraph> {
  const depth = options.depth ?? 3;
  const includeCallees = options.callees !== false;

  // 1. Find definition
  const symbol = await findDefinition(symbolName, workspaceRoot);
  if (!symbol) {
    return {
      symbol: {
        name: symbolName,
        kind: 'function',
        file: '(not found)',
        line: 0,
        params: '',
        returnType: '',
        body: '',
      },
      imports: [],
      callers: [],
      callees: [],
      upstreamChain: [],
    };
  }

  // 2. Find all references
  const { callers, imports } = await findReferences(symbolName, symbol.file, workspaceRoot);

  // 3. Extract outgoing calls from body
  let callees: OutgoingCall[] = [];
  if (includeCallees && symbol.body) {
    const allFiles = await collectFiles(workspaceRoot, workspaceRoot);
    const knownSymbols = new Set<string>();
    // Quick scan for exported symbols
    for (const f of allFiles) {
      try {
        const content = await readFile(f, 'utf-8');
        const matches = content.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/g);
        for (const m of matches) knownSymbols.add(m[1]!);
        const constMatches = content.matchAll(/export\s+const\s+(\w+)/g);
        for (const m of constMatches) knownSymbols.add(m[1]!);
        const classMatches = content.matchAll(/(?:export\s+)?class\s+(\w+)/g);
        for (const m of classMatches) knownSymbols.add(m[1]!);
      } catch { /* skip */ }
    }
    callees = extractOutgoingCalls(symbol.body, symbolName, knownSymbols);
  }

  // 4. Build upstream chain
  const upstreamChain = depth > 0
    ? await buildUpstreamChain(symbolName, workspaceRoot, depth)
    : [];

  return { symbol, imports, callers, callees, upstreamChain };
}

// ── Formatters ───────────────────────────────────────────────────────────────

/**
 * Format the call graph as a Mermaid flowchart diagram.
 */
export function formatMermaid(graph: CallGraph): string {
  const lines: string[] = ['graph TD'];
  const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, '_');
  const nodeId = (name: string, file: string) => sanitize(`${name}_${file.replace(/[/.]/g, '_')}`);

  const defId = nodeId(graph.symbol.name, graph.symbol.file);
  const shortFile = graph.symbol.file.split('/').slice(-2).join('/');
  lines.push(`  ${defId}["<b>${graph.symbol.name}</b><br/><i>${shortFile}:${graph.symbol.line}</i>"]`);

  // Callers → symbol
  const callerGroups = new Map<string, { file: string; line: number; count: number }>();
  for (const caller of graph.callers) {
    const callerFunc = caller.code.match(/(\w+)\s*\(/)?.[1] ?? caller.file;
    const key = `${callerFunc}@${caller.file}`;
    if (!callerGroups.has(key)) {
      callerGroups.set(key, { file: caller.file, line: caller.line, count: 1 });
    } else {
      callerGroups.get(key)!.count++;
    }
  }

  for (const [key, info] of callerGroups) {
    const callerName = key.split('@')[0]!;
    const id = nodeId(callerName, info.file);
    const sf = info.file.split('/').slice(-2).join('/');
    lines.push(`  ${id}["${callerName}<br/><i>${sf}:${info.line}</i>"]`);
    const label = info.count > 1 ? `|"${info.count}x"|` : '';
    lines.push(`  ${id} --> ${label}${defId}`);
  }

  // Symbol → callees
  for (const callee of graph.callees) {
    const id = sanitize(`callee_${callee.name}`);
    const target = callee.targetFile ? `<br/><i>${callee.targetFile}</i>` : '';
    lines.push(`  ${id}["${callee.name}${target}"]`);
    lines.push(`  ${defId} --> ${id}`);
  }

  // Style
  lines.push('');
  lines.push(`  style ${defId} fill:#2563eb,color:#fff,stroke:#1d4ed8`);
  for (const [key, info] of callerGroups) {
    const callerName = key.split('@')[0]!;
    lines.push(`  style ${nodeId(callerName, info.file)} fill:#059669,color:#fff,stroke:#047857`);
  }
  for (const callee of graph.callees) {
    lines.push(`  style ${sanitize(`callee_${callee.name}`)} fill:#d97706,color:#fff,stroke:#b45309`);
  }

  return lines.join('\n');
}

/**
 * Format the call graph as a readable ASCII tree.
 */
export function formatAsciiTree(graph: CallGraph): string {
  const lines: string[] = [];
  const sym = graph.symbol;

  // Header
  lines.push(`${sym.name}${sym.params} → ${sym.returnType || '(void)'}`);
  lines.push(`  Defined: ${sym.file}:${sym.line}  [${sym.kind}]`);
  lines.push('');

  // Imports
  if (graph.imports.length > 0) {
    lines.push('  Imported by:');
    for (const imp of graph.imports) {
      lines.push(`  │ ${imp.file}:${imp.line}`);
    }
    lines.push('');
  }

  // Callers (inbound)
  if (graph.callers.length > 0) {
    lines.push('  Called from:');
    for (let i = 0; i < graph.callers.length; i++) {
      const c = graph.callers[i]!;
      const prefix = i === graph.callers.length - 1 ? '└─' : '├─';
      const argsDisplay = c.args ? `  args: (${c.args})` : '';
      lines.push(`  ${prefix} ${c.file}:${c.line}    ${c.code.slice(0, 80)}${argsDisplay}`);
    }
    lines.push('');
  }

  // Callees (outbound)
  if (graph.callees.length > 0) {
    lines.push('  Calls into:');
    for (let i = 0; i < graph.callees.length; i++) {
      const c = graph.callees[i]!;
      const prefix = i === graph.callees.length - 1 ? '└─' : '├─';
      const target = c.targetFile ? ` [${c.targetFile}]` : '';
      const argsDisplay = c.args ? `(${c.args})` : '()';
      lines.push(`  ${prefix} ${c.name}${argsDisplay}${target}`);
    }
    lines.push('');
  }

  // Upstream chain
  if (graph.upstreamChain.length > 0) {
    lines.push('  Upstream call chain:');
    formatUpstreamTree(graph.upstreamChain, lines, '  ');
    lines.push('');
  }

  return lines.join('\n');
}

function formatUpstreamTree(nodes: UpstreamNode[], lines: string[], indent: string): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const isLast = i === nodes.length - 1;
    const prefix = isLast ? '└─' : '├─';
    lines.push(`${indent}${prefix} ${node.name} (${node.file}:${node.line})`);
    if (node.callers.length > 0) {
      const childIndent = indent + (isLast ? '  ' : '│ ');
      formatUpstreamTree(node.callers, lines, childIndent);
    }
  }
}

/**
 * Build a context string for the AI to analyze the call graph.
 */
export function formatGraphForAI(graph: CallGraph): string {
  const sections: string[] = [];

  sections.push(`# Call Graph: ${graph.symbol.name}`);
  sections.push('');
  sections.push(`**Definition:** \`${graph.symbol.file}:${graph.symbol.line}\` (${graph.symbol.kind})`);
  sections.push(`**Signature:** \`${graph.symbol.name}${graph.symbol.params}\` → \`${graph.symbol.returnType || 'void'}\``);
  sections.push('');

  if (graph.imports.length > 0) {
    sections.push('## Imported by');
    for (const imp of graph.imports) {
      sections.push(`- \`${imp.file}:${imp.line}\`: \`${imp.code}\``);
    }
    sections.push('');
  }

  if (graph.callers.length > 0) {
    sections.push('## Call Sites (inbound)');
    for (const c of graph.callers) {
      sections.push(`- \`${c.file}:${c.line}\`: \`${c.code.slice(0, 120)}\``);
    }
    sections.push('');
  }

  if (graph.callees.length > 0) {
    sections.push('## Outgoing Calls');
    for (const c of graph.callees) {
      sections.push(`- \`${c.name}(${c.args})\`${c.targetFile ? ` → ${c.targetFile}` : ''}`);
    }
    sections.push('');
  }

  if (graph.symbol.body) {
    sections.push('## Source Body');
    sections.push('```');
    sections.push(graph.symbol.body.slice(0, 3000));
    sections.push('```');
  }

  return sections.join('\n');
}
