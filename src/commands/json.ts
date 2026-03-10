/**
 * `jam json` — JSON swiss knife.
 *
 * Pretty print, query (dot-path), diff two files, minify, sort keys.
 * Reads from file or stdin.
 */

import { readFileSync } from 'node:fs';
import chalk from 'chalk';

// ── Dot-path query engine ────────────────────────────────────────────────────

function queryPath(obj: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current)) {
      const idx = parseInt(part, 10);
      if (isNaN(idx)) return undefined;
      current = current[idx];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

// ── Deep sort keys ───────────────────────────────────────────────────────────

function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj !== null && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

// ── JSON diff ────────────────────────────────────────────────────────────────

interface DiffEntry {
  path: string;
  type: 'added' | 'removed' | 'changed';
  oldValue?: unknown;
  newValue?: unknown;
}

function diffObjects(a: unknown, b: unknown, path = ''): DiffEntry[] {
  const diffs: DiffEntry[] = [];

  if (a === b) return diffs;

  // Type mismatch or primitives differ
  if (typeof a !== typeof b || a === null || b === null ||
      typeof a !== 'object' || typeof b !== 'object') {
    diffs.push({ path: path || '$', type: 'changed', oldValue: a, newValue: b });
    return diffs;
  }

  // Arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      const itemPath = `${path}[${i}]`;
      if (i >= a.length) {
        diffs.push({ path: itemPath, type: 'added', newValue: b[i] });
      } else if (i >= b.length) {
        diffs.push({ path: itemPath, type: 'removed', oldValue: a[i] });
      } else {
        diffs.push(...diffObjects(a[i], b[i], itemPath));
      }
    }
    return diffs;
  }

  // Objects
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);

  for (const key of allKeys) {
    const keyPath = path ? `${path}.${key}` : key;
    if (!(key in aObj)) {
      diffs.push({ path: keyPath, type: 'added', newValue: bObj[key] });
    } else if (!(key in bObj)) {
      diffs.push({ path: keyPath, type: 'removed', oldValue: aObj[key] });
    } else {
      diffs.push(...diffObjects(aObj[key], bObj[key], keyPath));
    }
  }

  return diffs;
}

// ── Colored JSON output ──────────────────────────────────────────────────────

function colorizeJson(json: string): string {
  return json
    .replace(/"([^"]+)":/g, `${chalk.cyan('"$1"')}:`)
    .replace(/: "(.*?)"/g, `: ${chalk.green('"$1"')}`)
    .replace(/: (\d+\.?\d*)/g, `: ${chalk.yellow('$1')}`)
    .replace(/: (true|false)/g, `: ${chalk.magenta('$1')}`)
    .replace(/: (null)/g, `: ${chalk.dim('$1')}`);
}

// ── stdin reader ─────────────────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

export interface JsonOptions {
  query?: string;
  diff?: string;
  minify?: boolean;
  sortKeys?: boolean;
  color?: boolean;
  flatten?: boolean;
}

export async function runJson(file: string | undefined, options: JsonOptions): Promise<void> {
  // Read input
  let input: string;
  if (file) {
    try {
      input = readFileSync(file, 'utf-8');
    } catch {
      process.stderr.write(`Cannot read: ${file}\n`);
      process.exit(1);
      return;
    }
  } else if (!process.stdin.isTTY) {
    input = await readStdin();
  } else {
    process.stderr.write('Usage: jam json <file> or pipe JSON via stdin\n');
    process.stderr.write('  jam json data.json --query "users[0].name"\n');
    process.stderr.write('  cat data.json | jam json --minify\n');
    process.stderr.write('  jam json a.json --diff b.json\n');
    return;
  }

  let data: unknown;
  try {
    data = JSON.parse(input);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${chalk.red('Invalid JSON')}: ${msg}\n`);
    process.exit(1);
    return;
  }

  // ── Diff mode ──────────────────────────────────────────────────────────
  if (options.diff) {
    let other: unknown;
    try {
      other = JSON.parse(readFileSync(options.diff, 'utf-8'));
    } catch {
      process.stderr.write(`Cannot read or parse: ${options.diff}\n`);
      process.exit(1);
      return;
    }

    const diffs = diffObjects(data, other);
    if (diffs.length === 0) {
      process.stdout.write(chalk.green('Files are identical.\n'));
      return;
    }

    process.stdout.write(`\n${chalk.bold('JSON Diff')} ${chalk.dim(`(${diffs.length} changes)`)}\n\n`);
    for (const d of diffs) {
      const pathStr = chalk.cyan(d.path);
      switch (d.type) {
        case 'added':
          process.stdout.write(`  ${chalk.green('+')} ${pathStr}: ${chalk.green(JSON.stringify(d.newValue))}\n`);
          break;
        case 'removed':
          process.stdout.write(`  ${chalk.red('-')} ${pathStr}: ${chalk.red(JSON.stringify(d.oldValue))}\n`);
          break;
        case 'changed':
          process.stdout.write(`  ${chalk.yellow('~')} ${pathStr}: ${chalk.red(JSON.stringify(d.oldValue))} → ${chalk.green(JSON.stringify(d.newValue))}\n`);
          break;
      }
    }
    process.stdout.write('\n');
    return;
  }

  // ── Query mode ─────────────────────────────────────────────────────────
  if (options.query) {
    const result = queryPath(data, options.query);
    if (result === undefined) {
      process.stderr.write(`Path not found: ${options.query}\n`);
      process.exit(1);
      return;
    }
    if (typeof result === 'object' && result !== null) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(String(result) + '\n');
    }
    return;
  }

  // ── Sort keys ──────────────────────────────────────────────────────────
  if (options.sortKeys) {
    data = sortKeys(data);
  }

  // ── Flatten mode ───────────────────────────────────────────────────────
  if (options.flatten) {
    const flat: Record<string, unknown> = {};
    const flatten = (obj: unknown, prefix = '') => {
      if (obj === null || typeof obj !== 'object') {
        flat[prefix || '$'] = obj;
        return;
      }
      if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) flatten(obj[i], `${prefix}[${i}]`);
        return;
      }
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        flatten(v, prefix ? `${prefix}.${k}` : k);
      }
    };
    flatten(data);
    process.stdout.write(JSON.stringify(flat, null, 2) + '\n');
    return;
  }

  // ── Minify or pretty-print ─────────────────────────────────────────────
  if (options.minify) {
    process.stdout.write(JSON.stringify(data) + '\n');
  } else {
    const output = JSON.stringify(data, null, 2);
    const noColor = options.color === false;
    process.stdout.write((noColor ? output : colorizeJson(output)) + '\n');
  }
}
