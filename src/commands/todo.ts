/**
 * `jam todo` — scan codebase for TODO/FIXME/HACK/XXX/NOTE comments.
 *
 * Groups by type, enriches with git blame (author + age) on demand.
 * Zero LLM — pure regex + git.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { getWorkspaceRoot } from '../utils/workspace.js';

interface TodoItem {
  file: string;
  line: number;
  type: string;
  text: string;
  author?: string;
  age?: string;
  timestamp?: number;
}

const DEFAULT_PATTERN = /\b(TODO|FIXME|HACK|XXX|NOTE|WARN|BUG|OPTIMIZE|REVIEW)\b[:\s-]*(.*)/i;

const TYPE_COLORS: Record<string, (s: string) => string> = {
  TODO: chalk.yellow,
  FIXME: chalk.red,
  HACK: chalk.magenta,
  XXX: chalk.red.bold,
  BUG: chalk.red.bold,
  NOTE: chalk.blue,
  WARN: chalk.hex('#FFA500'),
  OPTIMIZE: chalk.cyan,
  REVIEW: chalk.green,
};

function formatAge(date: Date): string {
  const diff = Date.now() - date.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

export interface TodoOptions {
  byAuthor?: boolean;
  byAge?: boolean;
  json?: boolean;
  type?: string[];
  pattern?: string;
}

export async function runTodo(options: TodoOptions): Promise<void> {
  const root = await getWorkspaceRoot();

  // Get all tracked + unignored files
  let files: string[];
  try {
    files = execSync('git ls-files --cached --others --exclude-standard', {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    })
      .trim()
      .split('\n')
      .filter(Boolean);
  } catch {
    process.stderr.write('Not a git repository or git not available.\n');
    process.exit(1);
    return;
  }

  const pattern = options.pattern
    ? new RegExp(`\\b(${options.pattern})\\b[:\\s-]*(.*)`, 'gi')
    : DEFAULT_PATTERN;

  const typeFilter = options.type?.map((t) => t.toUpperCase());
  const todos: TodoItem[] = [];

  // Binary file extensions to skip
  const BINARY_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2',
    '.ttf', '.eot', '.mp3', '.mp4', '.zip', '.tar', '.gz', '.pdf',
    '.exe', '.dll', '.so', '.dylib', '.lock', '.bin',
  ]);

  for (const file of files) {
    const ext = file.slice(file.lastIndexOf('.'));
    if (BINARY_EXTS.has(ext)) continue;
    // Skip node_modules, dist, .git
    if (file.startsWith('node_modules/') || file.startsWith('dist/') || file.startsWith('.git/')) continue;

    try {
      const content = readFileSync(join(root, file), 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // Reset regex lastIndex for global patterns
        pattern.lastIndex = 0;
        const match = pattern.exec(lines[i]!);
        if (match) {
          const type = match[1]!.toUpperCase();
          if (typeFilter && !typeFilter.includes(type)) continue;
          todos.push({
            file,
            line: i + 1,
            type,
            text: (match[2] ?? '').trim(),
          });
        }
      }
    } catch {
      // Skip binary/unreadable files
    }
  }

  if (todos.length === 0) {
    process.stdout.write('No TODOs found.\n');
    return;
  }

  // Enrich with git blame
  if (options.byAuthor || options.byAge) {
    for (const todo of todos) {
      try {
        const blame = execSync(
          `git blame -L ${todo.line},${todo.line} --porcelain -- "${todo.file}"`,
          { cwd: root, encoding: 'utf-8', timeout: 5000 },
        );
        const authorMatch = blame.match(/^author (.+)$/m);
        const timeMatch = blame.match(/^author-time (\d+)$/m);
        if (authorMatch) todo.author = authorMatch[1];
        if (timeMatch) {
          const ts = parseInt(timeMatch[1]!, 10);
          todo.timestamp = ts;
          todo.age = formatAge(new Date(ts * 1000));
        }
      } catch {
        // Skip uncommitted lines
        todo.author = todo.author ?? 'uncommitted';
        todo.age = todo.age ?? 'new';
      }
    }
  }

  // Sort
  if (options.byAge && todos[0]?.timestamp !== undefined) {
    todos.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }

  if (options.json) {
    const output = todos.map(({ timestamp: _ts, ...rest }) => rest);
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }

  // Group and display
  if (options.byAuthor) {
    const grouped = new Map<string, TodoItem[]>();
    for (const t of todos) {
      const key = t.author ?? 'unknown';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(t);
    }
    for (const [author, items] of grouped) {
      process.stdout.write(`\n${chalk.bold.cyan(author)} ${chalk.dim(`(${items.length})`)}\n`);
      for (const t of items) {
        const colorFn = TYPE_COLORS[t.type] ?? chalk.white;
        const age = t.age ? chalk.dim(` ${t.age}`) : '';
        process.stdout.write(
          `  ${colorFn(t.type.padEnd(8))} ${chalk.dim(`${t.file}:${t.line}`)}${age}\n`,
        );
        if (t.text) process.stdout.write(`  ${' '.repeat(8)} ${t.text}\n`);
      }
    }
  } else {
    // Group by type
    const grouped = new Map<string, TodoItem[]>();
    for (const t of todos) {
      if (!grouped.has(t.type)) grouped.set(t.type, []);
      grouped.get(t.type)!.push(t);
    }

    // Summary bar
    const parts: string[] = [];
    for (const [type, items] of grouped) {
      const colorFn = TYPE_COLORS[type] ?? chalk.white;
      parts.push(colorFn(`${type}: ${items.length}`));
    }
    process.stdout.write(`\n${chalk.bold('Found')} ${chalk.bold.white(String(todos.length))} items  ${parts.join('  ')}\n`);

    for (const [type, items] of grouped) {
      const colorFn = TYPE_COLORS[type] ?? chalk.white;
      process.stdout.write(`\n${chalk.bold(colorFn(type))} ${chalk.dim(`(${items.length})`)}\n`);
      for (const t of items) {
        const age = t.age ? chalk.dim(` ${t.age}`) : '';
        const author = t.author ? chalk.dim(` [${t.author}]`) : '';
        process.stdout.write(`  ${chalk.dim(`${t.file}:${t.line}`)}${age}${author}\n`);
        if (t.text) process.stdout.write(`    ${t.text}\n`);
      }
    }
  }

  process.stdout.write('\n');
}
