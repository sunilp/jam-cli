/**
 * `jam recent` — show recently modified files by git activity.
 *
 * Answers: "what was I working on?" / "what files are hot right now?"
 */

import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { getWorkspaceRoot } from '../utils/workspace.js';

interface RecentFile {
  file: string;
  commits: number;
  lastModified: string;
  authors: string[];
}

export interface RecentOptions {
  days?: number;
  json?: boolean;
  author?: string;
  limit?: number;
}

export async function runRecent(options: RecentOptions): Promise<void> {
  const root = await getWorkspaceRoot();
  const days = options.days ?? 7;
  const limit = options.limit ?? 30;

  const authorFlag = options.author ? `--author="${options.author}"` : '';

  // Get file changes from git log
  let raw: string;
  try {
    raw = execSync(
      `git log --since="${days} days ago" --name-only --pretty=format:"__COMMIT__%H__%ai__%an" ${authorFlag}`,
      { cwd: root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
  } catch {
    process.stderr.write('Not a git repository or no recent commits.\n');
    process.exit(1);
    return;
  }

  const fileMap = new Map<string, { commits: number; lastDate: string; authors: Set<string> }>();
  let currentDate = '';
  let currentAuthor = '';

  for (const line of raw.split('\n')) {
    if (line.startsWith('__COMMIT__')) {
      const parts = line.split('__');
      currentDate = parts[3] ?? '';
      currentAuthor = parts[4] ?? '';
      continue;
    }
    const file = line.trim();
    if (!file) continue;

    const entry = fileMap.get(file) ?? { commits: 0, lastDate: '', authors: new Set<string>() };
    entry.commits++;
    if (!entry.lastDate || currentDate > entry.lastDate) {
      entry.lastDate = currentDate;
    }
    if (currentAuthor) entry.authors.add(currentAuthor);
    fileMap.set(file, entry);
  }

  if (fileMap.size === 0) {
    process.stdout.write(`No file changes in the last ${days} days.\n`);
    return;
  }

  // Sort by commit frequency (descending), then by recency
  const sorted: RecentFile[] = Array.from(fileMap.entries())
    .map(([file, data]) => ({
      file,
      commits: data.commits,
      lastModified: data.lastDate,
      authors: Array.from(data.authors),
    }))
    .sort((a, b) => b.commits - a.commits || b.lastModified.localeCompare(a.lastModified))
    .slice(0, limit);

  if (options.json) {
    process.stdout.write(JSON.stringify(sorted, null, 2) + '\n');
    return;
  }

  // Time grouping
  const now = Date.now();
  const todayFiles: RecentFile[] = [];
  const weekFiles: RecentFile[] = [];
  const olderFiles: RecentFile[] = [];

  for (const f of sorted) {
    const date = new Date(f.lastModified).getTime();
    const diffDays = (now - date) / 86400000;
    if (diffDays < 1) todayFiles.push(f);
    else if (diffDays < 7) weekFiles.push(f);
    else olderFiles.push(f);
  }

  process.stdout.write(`\n${chalk.bold('Recently Modified Files')} ${chalk.dim(`(last ${days} days)`)}\n`);

  const maxCommits = sorted[0]?.commits ?? 1;

  const printGroup = (label: string, items: RecentFile[]) => {
    if (items.length === 0) return;
    process.stdout.write(`\n${chalk.bold.cyan(label)}\n`);
    for (const f of items) {
      // Frequency bar
      const barLen = Math.max(1, Math.round((f.commits / maxCommits) * 15));
      const bar = chalk.green('█'.repeat(barLen)) + chalk.dim('░'.repeat(15 - barLen));
      const commits = chalk.yellow(`${String(f.commits).padStart(3)}x`);
      const authors = f.authors.length > 1 ? chalk.dim(` [${f.authors.join(', ')}]`) : '';
      process.stdout.write(`  ${bar} ${commits}  ${f.file}${authors}\n`);
    }
  };

  printGroup('Today', todayFiles);
  printGroup('This Week', weekFiles);
  printGroup('Earlier', olderFiles);

  // Summary
  process.stdout.write(`\n${chalk.dim(`${fileMap.size} files changed, ${sorted.reduce((s, f) => s + f.commits, 0)} total commits`)}\n\n`);
}
