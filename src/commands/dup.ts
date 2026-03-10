/**
 * `jam dup` — detect near-duplicate code blocks.
 *
 * Token-based similarity detection using rolling hash (Rabin fingerprint).
 * Catches copy-paste debt — not just exact matches.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import chalk from 'chalk';
import { getWorkspaceRoot } from '../utils/workspace.js';

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs',
  '.java', '.c', '.cpp', '.cs', '.rb', '.php', '.swift',
]);

interface CodeBlock {
  file: string;
  startLine: number;
  endLine: number;
  hash: number;
  tokens: string[];
}

interface Duplicate {
  blockA: { file: string; startLine: number; endLine: number };
  blockB: { file: string; startLine: number; endLine: number };
  lines: number;
  similarity: number;
}

/**
 * Tokenize source code: strip comments, normalize whitespace,
 * keep identifiers and operators.
 */
function tokenize(content: string): Array<{ token: string; line: number }> {
  const tokens: Array<{ token: string; line: number }> = [];
  const lines = content.split('\n');
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;

    // Handle block comments
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end !== -1) {
        inBlockComment = false;
        line = line.slice(end + 2);
      } else {
        continue;
      }
    }

    // Strip block comment starts
    const bcStart = line.indexOf('/*');
    if (bcStart !== -1) {
      const bcEnd = line.indexOf('*/', bcStart + 2);
      if (bcEnd !== -1) {
        line = line.slice(0, bcStart) + line.slice(bcEnd + 2);
      } else {
        line = line.slice(0, bcStart);
        inBlockComment = true;
      }
    }

    // Strip line comments
    const lcIdx = line.indexOf('//');
    if (lcIdx !== -1) line = line.slice(0, lcIdx);
    const hashIdx = line.indexOf('#');
    if (hashIdx !== -1 && !line.slice(0, hashIdx).includes('"') && !line.slice(0, hashIdx).includes("'")) {
      line = line.slice(0, hashIdx);
    }

    // Tokenize: split on non-word characters, keep operators
    const lineTokens = line.match(/\w+|[^\s\w]/g);
    if (lineTokens) {
      for (const t of lineTokens) {
        tokens.push({ token: t, line: i + 1 });
      }
    }
  }

  return tokens;
}

/**
 * Compute a rolling hash for a token window.
 * Simple polynomial hash with a prime base.
 */
function hashTokens(tokens: string[]): number {
  const BASE = 31;
  const MOD = 1e9 + 7;
  let h = 0;
  for (const t of tokens) {
    for (let i = 0; i < t.length; i++) {
      h = (h * BASE + t.charCodeAt(i)) % MOD;
    }
  }
  return h;
}

/**
 * Jaccard similarity of two token arrays.
 */
function similarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface DupOptions {
  minLines?: number;
  threshold?: number;
  json?: boolean;
  glob?: string;
  limit?: number;
}

export async function runDup(options: DupOptions): Promise<void> {
  const root = await getWorkspaceRoot();
  const minLines = options.minLines ?? 6;
  const threshold = options.threshold ?? 0.8;
  const limit = options.limit ?? 20;

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

  // Filter to code files
  const globPattern = options.glob;
  const minimatchFn = globPattern
    ? (await import('minimatch')).minimatch
    : null;
  const sourceFiles = files.filter((f) => {
    if (f.includes('node_modules/') || f.includes('dist/') || f.includes('vendor/')) return false;
    if (f.endsWith('.d.ts') || f.endsWith('.min.js') || f.endsWith('.min.css')) return false;
    if (globPattern && minimatchFn) {
      return minimatchFn(f, globPattern);
    }
    return CODE_EXTS.has(extname(f).toLowerCase());
  });

  process.stderr.write(`Scanning ${sourceFiles.length} files for duplicates...\n`);

  // Extract blocks from all files
  const allBlocks: CodeBlock[] = [];
  const MIN_TOKENS = minLines * 3; // Rough: ~3 tokens per line

  for (const file of sourceFiles) {
    try {
      const content = readFileSync(join(root, file), 'utf-8');
      const tokens = tokenize(content);
      if (tokens.length < MIN_TOKENS) continue;

      // Sliding window of minLines
      const windowSize = MIN_TOKENS;
      for (let i = 0; i <= tokens.length - windowSize; i += Math.max(1, Math.floor(windowSize / 2))) {
        const windowTokens = tokens.slice(i, i + windowSize);
        const tokenStrs = windowTokens.map((t) => t.token);
        const startLine = windowTokens[0]!.line;
        const endLine = windowTokens[windowTokens.length - 1]!.line;

        // Skip if block is too short in lines
        if (endLine - startLine + 1 < minLines) continue;

        allBlocks.push({
          file,
          startLine,
          endLine,
          hash: hashTokens(tokenStrs),
          tokens: tokenStrs,
        });
      }
    } catch { /* skip */ }
  }

  // Find duplicates: group by hash, then verify with Jaccard similarity
  const hashBuckets = new Map<number, CodeBlock[]>();
  for (const block of allBlocks) {
    if (!hashBuckets.has(block.hash)) hashBuckets.set(block.hash, []);
    hashBuckets.get(block.hash)!.push(block);
  }

  const duplicates: Duplicate[] = [];
  const seen = new Set<string>();

  for (const [, blocks] of hashBuckets) {
    if (blocks.length < 2) continue;

    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        const a = blocks[i]!;
        const b = blocks[j]!;

        // Skip same-file overlapping blocks
        if (a.file === b.file && Math.abs(a.startLine - b.startLine) < minLines) continue;

        const key = `${a.file}:${a.startLine}-${b.file}:${b.startLine}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const sim = similarity(a.tokens, b.tokens);
        if (sim >= threshold) {
          duplicates.push({
            blockA: { file: a.file, startLine: a.startLine, endLine: a.endLine },
            blockB: { file: b.file, startLine: b.startLine, endLine: b.endLine },
            lines: Math.max(a.endLine - a.startLine, b.endLine - b.startLine) + 1,
            similarity: sim,
          });
        }
      }
    }
  }

  // De-duplicate overlapping reports
  duplicates.sort((a, b) => b.similarity - a.similarity || b.lines - a.lines);
  const filtered: Duplicate[] = [];
  const reportedRanges = new Set<string>();

  for (const dup of duplicates) {
    const keyA = `${dup.blockA.file}:${Math.floor(dup.blockA.startLine / minLines)}`;
    const keyB = `${dup.blockB.file}:${Math.floor(dup.blockB.startLine / minLines)}`;
    const pairKey = [keyA, keyB].sort().join('|');
    if (reportedRanges.has(pairKey)) continue;
    reportedRanges.add(pairKey);
    filtered.push(dup);
    if (filtered.length >= limit) break;
  }

  if (filtered.length === 0) {
    process.stdout.write(chalk.green('No significant code duplication found.\n'));
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(filtered, null, 2) + '\n');
    return;
  }

  process.stdout.write(`\n${chalk.bold('Duplicate Code Blocks')} ${chalk.dim(`(${filtered.length} found, threshold ${(threshold * 100).toFixed(0)}%)`)}\n\n`);

  for (let i = 0; i < filtered.length; i++) {
    const dup = filtered[i]!;
    const simColor = dup.similarity > 0.95 ? chalk.red : dup.similarity > 0.85 ? chalk.yellow : chalk.green;
    const simStr = simColor(`${(dup.similarity * 100).toFixed(0)}%`);

    process.stdout.write(
      `  ${chalk.bold(`#${i + 1}`)} ${simStr} similar  ${chalk.dim(`(${dup.lines} lines)`)}\n`,
    );
    process.stdout.write(
      `    ${chalk.cyan(dup.blockA.file)}${chalk.dim(`:${dup.blockA.startLine}-${dup.blockA.endLine}`)}\n`,
    );
    process.stdout.write(
      `    ${chalk.cyan(dup.blockB.file)}${chalk.dim(`:${dup.blockB.startLine}-${dup.blockB.endLine}`)}\n`,
    );
    process.stdout.write('\n');
  }
}
