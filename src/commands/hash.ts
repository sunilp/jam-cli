/**
 * `jam hash` — smart file/directory hashing.
 *
 * Content hashing with .gitignore awareness, dirty detection,
 * and directory checksums for CI cache keys.
 */

import { createHash, type Hash } from 'node:crypto';
import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { getWorkspaceRoot } from '../utils/workspace.js';

function getGitignorePatterns(root: string): Set<string> {
  const ignored = new Set<string>();
  try {
    const files = execSync('git ls-files --others --ignored --exclude-standard --directory', {
      cwd: root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
    }).trim().split('\n').filter(Boolean);
    for (const f of files) ignored.add(f.replace(/\/$/, ''));
  } catch { /* not git */ }
  return ignored;
}

function hashFile(filePath: string, algo: string): string {
  const content = readFileSync(filePath);
  return createHash(algo).update(content).digest('hex');
}

function hashDirectory(dirPath: string, algo: string, root: string, ignored: Set<string>): { hash: string; files: number; bytes: number } {
  const hasher: Hash = createHash(algo);
  let fileCount = 0;
  let totalBytes = 0;

  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name)); // Deterministic order

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath);

      // Skip ignored and common junk
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.DS_Store') continue;
      if (ignored.has(relPath)) continue;

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const content = readFileSync(fullPath);
          // Include relative path in hash so renames are detected
          hasher.update(relPath);
          hasher.update(content);
          fileCount++;
          totalBytes += content.length;
        } catch { /* skip unreadable */ }
      }
    }
  };

  walk(dirPath);
  return { hash: hasher.digest('hex'), files: fileCount, bytes: totalBytes };
}

export interface HashOptions {
  algo?: string;
  json?: boolean;
  check?: string;
  dirty?: boolean;
  short?: boolean;
}

export async function runHash(paths: string[], options: HashOptions): Promise<void> {
  const algo = options.algo ?? 'sha256';
  const root = await getWorkspaceRoot().catch(() => process.cwd());
  const ignored = getGitignorePatterns(root);

  // Dirty mode: show modified files and their hashes
  if (options.dirty) {
    try {
      const modified = execSync('git diff --name-only', { cwd: root, encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean);
      const staged = execSync('git diff --staged --name-only', { cwd: root, encoding: 'utf-8' })
        .trim().split('\n').filter(Boolean);
      const dirty = [...new Set([...modified, ...staged])];

      if (dirty.length === 0) {
        process.stdout.write('Working tree is clean.\n');
        return;
      }

      const results = dirty.map((file) => {
        try {
          const hash = hashFile(join(root, file), algo);
          return { file, hash: options.short ? hash.slice(0, 12) : hash };
        } catch {
          return { file, hash: 'deleted' };
        }
      });

      if (options.json) {
        process.stdout.write(JSON.stringify(results, null, 2) + '\n');
        return;
      }

      process.stdout.write(`\n${chalk.bold('Dirty Files')}\n\n`);
      for (const r of results) {
        const color = r.hash === 'deleted' ? chalk.red : chalk.yellow;
        process.stdout.write(`  ${color(r.hash.padEnd(options.short ? 12 : 16))}  ${r.file}\n`);
      }
      process.stdout.write('\n');
      return;
    } catch {
      process.stderr.write('Not a git repository.\n');
      process.exit(1);
    }
  }

  // Check mode: verify hashes from a file
  if (options.check) {
    const checkFile = readFileSync(options.check, 'utf-8');
    const entries = checkFile.trim().split('\n').map((line) => {
      const [hash, ...rest] = line.split(/\s+/);
      return { expectedHash: hash!, path: rest.join(' ') };
    });

    let allOk = true;
    for (const entry of entries) {
      const fullPath = join(root, entry.path);
      try {
        const actual = statSync(fullPath).isDirectory()
          ? hashDirectory(fullPath, algo, root, ignored).hash
          : hashFile(fullPath, algo);
        const match = actual === entry.expectedHash || actual.startsWith(entry.expectedHash);
        if (match) {
          process.stdout.write(`${chalk.green('OK')}   ${entry.path}\n`);
        } else {
          process.stdout.write(`${chalk.red('FAIL')} ${entry.path}  expected ${entry.expectedHash.slice(0, 12)}… got ${actual.slice(0, 12)}…\n`);
          allOk = false;
        }
      } catch {
        process.stdout.write(`${chalk.red('MISS')} ${entry.path}  not found\n`);
        allOk = false;
      }
    }
    process.exit(allOk ? 0 : 1);
    return;
  }

  // Default: hash given paths
  if (paths.length === 0) {
    paths = ['.'];
  }

  const results: Array<{ path: string; hash: string; files?: number; bytes?: number }> = [];

  for (const p of paths) {
    const fullPath = join(root, p);
    if (!existsSync(fullPath)) {
      process.stderr.write(`Not found: ${p}\n`);
      continue;
    }

    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      const { hash, files, bytes } = hashDirectory(fullPath, algo, root, ignored);
      const display = options.short ? hash.slice(0, 12) : hash;
      results.push({ path: p, hash: display, files, bytes });
    } else {
      const hash = hashFile(fullPath, algo);
      const display = options.short ? hash.slice(0, 12) : hash;
      results.push({ path: p, hash: display, bytes: stat.size });
    }
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    return;
  }

  for (const r of results) {
    const meta: string[] = [];
    if (r.files !== undefined) meta.push(`${r.files} files`);
    if (r.bytes !== undefined) {
      meta.push(r.bytes > 1024 * 1024
        ? `${(r.bytes / 1024 / 1024).toFixed(1)}MB`
        : r.bytes > 1024
          ? `${(r.bytes / 1024).toFixed(1)}KB`
          : `${r.bytes}B`);
    }
    const suffix = meta.length > 0 ? chalk.dim(`  (${meta.join(', ')})`) : '';
    process.stdout.write(`${chalk.green(r.hash)}  ${r.path}${suffix}\n`);
  }
}
