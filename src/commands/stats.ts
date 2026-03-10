/**
 * `jam stats` — instant codebase health dashboard.
 *
 * LOC by language, largest files, git churn, complexity hotspots.
 * Zero LLM — pure file system + git.
 */

import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import chalk from 'chalk';
import { getWorkspaceRoot } from '../utils/workspace.js';

const EXT_LANGUAGES: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript (JSX)', '.js': 'JavaScript',
  '.jsx': 'JavaScript (JSX)', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust',
  '.java': 'Java', '.kt': 'Kotlin', '.swift': 'Swift', '.c': 'C',
  '.cpp': 'C++', '.h': 'C/C++ Header', '.cs': 'C#', '.php': 'PHP',
  '.vue': 'Vue', '.svelte': 'Svelte', '.astro': 'Astro',
  '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.less': 'Less',
  '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
  '.xml': 'XML', '.md': 'Markdown', '.sql': 'SQL', '.sh': 'Shell',
  '.bash': 'Shell', '.zsh': 'Shell', '.fish': 'Shell',
  '.dockerfile': 'Dockerfile', '.tf': 'Terraform', '.hcl': 'HCL',
  '.proto': 'Protobuf', '.graphql': 'GraphQL', '.gql': 'GraphQL',
};

interface LangStats {
  language: string;
  files: number;
  lines: number;
  blank: number;
  comment: number;
  code: number;
}

interface FileInfo {
  file: string;
  lines: number;
  bytes: number;
}

interface ChurnEntry {
  file: string;
  commits: number;
}

function countLines(content: string): { total: number; blank: number; comment: number; code: number } {
  const lines = content.split('\n');
  let blank = 0;
  let comment = 0;
  let inBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { blank++; continue; }

    // Simple block comment detection
    if (inBlock) {
      comment++;
      if (trimmed.includes('*/')) inBlock = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      comment++;
      if (!trimmed.includes('*/')) inBlock = false;
      inBlock = !trimmed.includes('*/');
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('--')) {
      comment++;
      continue;
    }
  }

  return {
    total: lines.length,
    blank,
    comment,
    code: lines.length - blank - comment,
  };
}

export interface StatsOptions {
  json?: boolean;
  sort?: string;
}

export async function runStats(options: StatsOptions): Promise<void> {
  const root = await getWorkspaceRoot();

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

  // Skip non-source files
  const skipDirs = ['node_modules/', 'dist/', '.git/', 'vendor/', 'build/', '.next/', 'coverage/'];

  const langMap = new Map<string, LangStats>();
  const fileInfos: FileInfo[] = [];

  for (const file of files) {
    if (skipDirs.some((d) => file.startsWith(d))) continue;

    const ext = extname(file).toLowerCase();
    const lang = EXT_LANGUAGES[ext];
    if (!lang) continue;

    try {
      const fullPath = join(root, file);
      const stat = statSync(fullPath);
      if (stat.size > 1024 * 1024) continue; // Skip >1MB files

      const content = readFileSync(fullPath, 'utf-8');
      const counts = countLines(content);

      fileInfos.push({ file, lines: counts.total, bytes: stat.size });

      const entry = langMap.get(lang) ?? { language: lang, files: 0, lines: 0, blank: 0, comment: 0, code: 0 };
      entry.files++;
      entry.lines += counts.total;
      entry.blank += counts.blank;
      entry.comment += counts.comment;
      entry.code += counts.code;
      langMap.set(lang, entry);
    } catch {
      // Skip unreadable files
    }
  }

  // Git churn (last 90 days)
  const churnMap = new Map<string, number>();
  try {
    const log = execSync(
      'git log --since="90 days ago" --name-only --pretty=format:""',
      { cwd: root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
    );
    for (const line of log.split('\n')) {
      const f = line.trim();
      if (!f) continue;
      churnMap.set(f, (churnMap.get(f) ?? 0) + 1);
    }
  } catch {
    // Git churn unavailable
  }

  const churn: ChurnEntry[] = Array.from(churnMap.entries())
    .map(([file, commits]) => ({ file, commits }))
    .sort((a, b) => b.commits - a.commits)
    .slice(0, 10);

  // Sort languages
  const languages = Array.from(langMap.values());
  const sortField = options.sort ?? 'code';
  languages.sort((a, b) => {
    const key = sortField as keyof LangStats;
    const bVal = b[key];
    const aVal = a[key];
    return (typeof bVal === 'number' ? bVal : 0) - (typeof aVal === 'number' ? aVal : 0);
  });

  const totalFiles = languages.reduce((s, l) => s + l.files, 0);
  const totalCode = languages.reduce((s, l) => s + l.code, 0);
  const totalLines = languages.reduce((s, l) => s + l.lines, 0);

  // Largest files
  const largest = [...fileInfos].sort((a, b) => b.lines - a.lines).slice(0, 10);

  // Complexity hotspots: files with highest branch density
  const complexFiles: Array<{ file: string; branches: number; lines: number; density: number }> = [];
  const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp']);
  for (const fi of fileInfos) {
    const ext = extname(fi.file).toLowerCase();
    if (!CODE_EXTS.has(ext)) continue;
    try {
      const content = readFileSync(join(root, fi.file), 'utf-8');
      const branches = (content.match(/\b(if|else|switch|case|for|while|catch|&&|\|\||\?)\b/g) ?? []).length;
      if (fi.lines > 20 && branches > 5) {
        complexFiles.push({ file: fi.file, branches, lines: fi.lines, density: branches / fi.lines });
      }
    } catch { /* skip */ }
  }
  complexFiles.sort((a, b) => b.density - a.density);

  if (options.json) {
    process.stdout.write(JSON.stringify({
      summary: { files: totalFiles, lines: totalLines, code: totalCode },
      languages,
      largestFiles: largest,
      churn,
      complexityHotspots: complexFiles.slice(0, 10),
    }, null, 2) + '\n');
    return;
  }

  // ── Display ──────────────────────────────────────────────────────────────

  process.stdout.write(`\n${chalk.bold('Codebase Stats')}\n`);
  process.stdout.write(chalk.dim('─'.repeat(65)) + '\n');

  // Summary
  process.stdout.write(
    `  ${chalk.bold(String(totalFiles))} files   ${chalk.bold(totalCode.toLocaleString())} lines of code   ${chalk.bold(totalLines.toLocaleString())} total lines\n\n`,
  );

  // Languages table
  process.stdout.write(`${chalk.bold.cyan('Languages')}\n`);
  const maxCode = languages[0]?.code ?? 1;
  for (const lang of languages.slice(0, 15)) {
    const barLen = Math.max(1, Math.round((lang.code / maxCode) * 25));
    const bar = chalk.green('█'.repeat(barLen));
    const pct = ((lang.code / totalCode) * 100).toFixed(1);
    process.stdout.write(
      `  ${lang.language.padEnd(20)} ${bar} ${chalk.white(String(lang.code).padStart(7))} ${chalk.dim(`(${pct}%)`)}  ${chalk.dim(`${lang.files} files`)}\n`,
    );
  }

  // Largest files
  process.stdout.write(`\n${chalk.bold.cyan('Largest Files')}\n`);
  for (const f of largest.slice(0, 8)) {
    const sizeStr = f.bytes > 1024 ? `${(f.bytes / 1024).toFixed(1)}KB` : `${f.bytes}B`;
    process.stdout.write(
      `  ${chalk.yellow(String(f.lines).padStart(6))} lines  ${chalk.dim(sizeStr.padStart(8))}  ${f.file}\n`,
    );
  }

  // Git churn
  if (churn.length > 0) {
    process.stdout.write(`\n${chalk.bold.cyan('Most Changed Files')} ${chalk.dim('(90 days)')}\n`);
    const maxChurn = churn[0]?.commits ?? 1;
    for (const c of churn.slice(0, 8)) {
      const barLen = Math.max(1, Math.round((c.commits / maxChurn) * 15));
      const bar = chalk.hex('#FFA500')('█'.repeat(barLen));
      process.stdout.write(
        `  ${bar} ${chalk.yellow(String(c.commits).padStart(4))}x  ${c.file}\n`,
      );
    }
  }

  // Complexity hotspots
  if (complexFiles.length > 0) {
    process.stdout.write(`\n${chalk.bold.cyan('Complexity Hotspots')} ${chalk.dim('(branch density)')}\n`);
    for (const c of complexFiles.slice(0, 8)) {
      const density = (c.density * 100).toFixed(1);
      const color = c.density > 0.3 ? chalk.red : c.density > 0.15 ? chalk.yellow : chalk.green;
      process.stdout.write(
        `  ${color(density.padStart(5) + '%')}  ${chalk.dim(`${c.branches} branches / ${c.lines} lines`)}  ${c.file}\n`,
      );
    }
  }

  process.stdout.write('\n');
}
