/**
 * `jam vibes` — hidden easter egg. Codebase vibe check.
 * Runs real analysis, delivers results as a witty personality report.
 * Zero LLM required.
 */

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { getWorkspaceRoot } from '../utils/workspace.js';

// ── Data collection ──────────────────────────────────────────────────────────

interface VibeData {
  totalFiles: number;
  totalLines: number;
  todoCount: number;
  fixmeCount: number;
  hackCount: number;
  oldestTodoAge: number | null; // days
  testCount: number;
  testsPassing: boolean | null;
  commitsThisWeek: number;
  commitsTotal: number;
  topContributor: string | null;
  largestFile: { name: string; lines: number } | null;
  languages: string[];
  hasLockfile: boolean;
  hasCi: boolean;
  avgFileSize: number;
  nodeModulesSize: string | null;
}

function exec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 }).toString().trim();
  } catch {
    return '';
  }
}

function countPattern(root: string, pattern: RegExp): number {
  let count = 0;
  function walk(dir: string): void {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const name = e.name;
      if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'coverage') continue;
      const full = join(dir, name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(ts|js|tsx|jsx|py|go|rs|java|rb|php|swift|kt|cs)$/i.test(name)) continue;
      try {
        const content = readFileSync(full, 'utf8');
        const matches = content.match(pattern);
        if (matches) count += matches.length;
      } catch { /* skip */ }
    }
  }
  walk(root);
  return count;
}

function countFiles(root: string): { files: number; lines: number; largest: { name: string; lines: number } | null; langs: Set<string> } {
  let files = 0, lines = 0;
  let largest: { name: string; lines: number } | null = null;
  const langs = new Set<string>();
  const extMap: Record<string, string> = {
    '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
    '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.rb': 'Ruby',
    '.php': 'PHP', '.swift': 'Swift', '.kt': 'Kotlin', '.cs': 'C#', '.css': 'CSS',
    '.html': 'HTML', '.md': 'Markdown', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML',
  };

  function walk(dir: string): void {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const name = e.name;
      if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'coverage') continue;
      const full = join(dir, name);
      if (e.isDirectory()) { walk(full); continue; }
      const ext = extname(name).toLowerCase();
      if (!ext || ext === '.lock' || ext === '.map') continue;
      files++;
      try {
        const content = readFileSync(full, 'utf8');
        const lc = content.split('\n').length;
        lines += lc;
        if (!largest || lc > largest.lines) largest = { name: name, lines: lc };
        if (extMap[ext]) langs.add(extMap[ext]);
      } catch { /* skip */ }
    }
  }
  walk(root);
  return { files, lines, largest, langs };
}

function collectVibeData(root: string): VibeData {
  const { files, lines, largest, langs } = countFiles(root);
  const todoCount = countPattern(root, /\bTODO\b/gi);
  const fixmeCount = countPattern(root, /\bFIXME\b/gi);
  const hackCount = countPattern(root, /\bHACK\b/gi);

  // Git stats
  const commitsWeek = exec('git log --oneline --since="7 days ago" 2>/dev/null | wc -l', root).trim();
  const commitsTotal = exec('git rev-list --count HEAD 2>/dev/null', root).trim();
  const topContrib = exec('git shortlog -sn --no-merges HEAD 2>/dev/null | head -1', root)
    .replace(/^\s*\d+\s+/, '').trim() || null;

  // Oldest TODO age
  let oldestTodoAge: number | null = null;
  const blameOutput = exec('git log --all --diff-filter=A -p --format="%at" 2>/dev/null | head -500', root);
  if (!blameOutput) oldestTodoAge = null;

  // Test detection
  let testCount = 0;
  const testsPassing: boolean | null = null;
  const testOutput = exec('grep -r "it(" --include="*.test.ts" --include="*.test.js" --include="*.spec.ts" -l 2>/dev/null | wc -l', root);
  testCount = parseInt(testOutput) || 0;

  // Check for CI
  const hasCi = (() => {
    try { statSync(join(root, '.github/workflows')); return true; } catch { /* */ }
    try { statSync(join(root, '.gitlab-ci.yml')); return true; } catch { /* */ }
    try { statSync(join(root, 'Jenkinsfile')); return true; } catch { /* */ }
    return false;
  })();

  // Lock file
  const hasLockfile = (() => {
    try { statSync(join(root, 'package-lock.json')); return true; } catch { /* */ }
    try { statSync(join(root, 'yarn.lock')); return true; } catch { /* */ }
    try { statSync(join(root, 'pnpm-lock.yaml')); return true; } catch { /* */ }
    return false;
  })();

  // node_modules size
  const nmSize = exec('du -sh node_modules 2>/dev/null | cut -f1', root).trim() || null;

  return {
    totalFiles: files,
    totalLines: lines,
    todoCount,
    fixmeCount,
    hackCount,
    oldestTodoAge,
    testCount,
    testsPassing,
    commitsThisWeek: parseInt(commitsWeek) || 0,
    commitsTotal: parseInt(commitsTotal) || 0,
    topContributor: topContrib,
    largestFile: largest,
    languages: [...langs],
    hasLockfile: hasLockfile,
    hasCi,
    avgFileSize: files > 0 ? Math.round(lines / files) : 0,
    nodeModulesSize: nmSize,
  };
}

// ── Personality engine ───────────────────────────────────────────────────────

function pickMood(data: VibeData): { emoji: string; label: string } {
  const debtScore = data.todoCount + data.fixmeCount * 2 + data.hackCount * 3;
  const hasTests = data.testCount > 0;
  const activeCommits = data.commitsThisWeek > 5;

  if (debtScore === 0 && hasTests) return { emoji: '\u{1F929}', label: 'Immaculate' };
  if (debtScore < 5 && hasTests && activeCommits) return { emoji: '\u{1F60E}', label: 'Cautiously Optimistic' };
  if (debtScore < 15 && hasTests) return { emoji: '\u{1F60A}', label: 'Content' };
  if (debtScore < 30) return { emoji: '\u{1F914}', label: 'Pensive' };
  if (debtScore < 60) return { emoji: '\u{1F605}', label: 'Nervous Laughter' };
  if (!hasTests && debtScore > 30) return { emoji: '\u{1F525}', label: 'This Is Fine' };
  return { emoji: '\u{1F480}', label: 'Send Help' };
}

function todoComment(count: number): string {
  if (count === 0) return '"Suspiciously clean"';
  if (count < 5) return '"Manageable. For now."';
  if (count < 15) return '"Future you is gonna hate past you"';
  if (count < 30) return '"These are basically features at this point"';
  return '"You spelled backlog wrong"';
}

function testComment(count: number): string {
  if (count === 0) return '"Living dangerously, I see"';
  if (count < 5) return '"A token gesture"';
  if (count < 20) return '"Getting there"';
  if (count < 50) return '"Responsible adult energy"';
  return '"Suspiciously thorough"';
}

function commitComment(perWeek: number): string {
  if (perWeek === 0) return '"On vacation or in production?"';
  if (perWeek < 3) return '"Zen mode"';
  if (perWeek < 10) return '"Steady hands"';
  if (perWeek < 30) return '"Locked in"';
  if (perWeek < 60) return '"Calm down, Linus"';
  return '"Is this a hackathon?"';
}

function fileSizeComment(avg: number): string {
  if (avg < 30) return '"Bite-sized"';
  if (avg < 80) return '"Chef\'s kiss"';
  if (avg < 150) return '"Getting chunky"';
  if (avg < 300) return '"Monolith vibes"';
  return '"This file has a file"';
}

function pickSong(data: VibeData): string {
  const debt = data.todoCount + data.fixmeCount + data.hackCount;
  const songs = [
    { cond: debt === 0 && data.testCount > 20, song: '"Feeling Good" \u2014 Nina Simone' },
    { cond: debt > 50, song: '"Under Pressure" \u2014 Queen' },
    { cond: data.commitsThisWeek > 40, song: '"Harder Better Faster Stronger" \u2014 Daft Punk' },
    { cond: data.commitsThisWeek === 0, song: '"The Sound of Silence" \u2014 Simon & Garfunkel' },
    { cond: data.testCount === 0, song: '"Highway to Hell" \u2014 AC/DC' },
    { cond: data.hackCount > 5, song: '"Bohemian Rhapsody" \u2014 Queen' },
    { cond: data.totalLines > 50000, song: '"Stairway to Heaven" \u2014 Led Zeppelin' },
    { cond: data.totalLines < 500, song: '"Just the Two of Us" \u2014 Bill Withers' },
    { cond: data.hasCi && data.testCount > 10, song: '"Don\'t Stop Me Now" \u2014 Queen' },
    { cond: true, song: '"Stayin\' Alive" \u2014 Bee Gees' },
  ];
  return songs.find(s => s.cond)!.song;
}

function pickFortune(): string {
  const fortunes = [
    '"A mass refactor is in your future. Resist."',
    '"Your tests pass, but do they test the right thing?"',
    '"The bug you\'re looking for is on line 42."',
    '"Today\'s TODO is tomorrow\'s legacy code."',
    '"A PR with no comments is either perfect or unreviewed."',
    '"The node_modules folder weighs more than your laptop."',
    '"git push --force is never the answer. Except when it is."',
    '"Your linter knows things about you that your therapist doesn\'t."',
    '"Somewhere, a junior dev is reading your code and learning bad habits."',
    '"The best code is the code you never have to write."',
    '"That env variable you forgot will surface at 3am."',
    '"You will meet a mysterious segfault in your travels."',
    '"The real tech debt was the friends we made along the way."',
    '"Ship it. Then fix it. Then ship the fix. Then fix the fix."',
    '"Your code is poetry. Unfortunately, it\'s a limerick."',
  ];
  return fortunes[Math.floor(Math.random() * fortunes.length)]!;
}

// ── Animation helpers ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function write(text: string): void {
  process.stdout.write(text);
}

async function animateLine(text: string, delayMs = 80): Promise<void> {
  write(text + '\n');
  await sleep(delayMs);
}

async function animateBar(
  label: string,
  value: number,
  max: number,
  suffix: string,
  colorFn: (s: string) => string,
  dimFn: (s: string) => string,
  width = 10,
): Promise<void> {
  const filled = Math.round((value / Math.max(max, 1)) * width);
  // Animate the bar filling up character by character
  write(`  ${dimFn(label)}   `);
  for (let i = 0; i < width; i++) {
    if (i < filled) {
      write(colorFn('\u2588'));
    } else {
      write(dimFn('\u2591'));
    }
    await sleep(15);
  }
  write(`  ${suffix}\n`);
  await sleep(30);
}

// ── Renderer ─────────────────────────────────────────────────────────────────

export async function runVibes(): Promise<void> {
  const root = await getWorkspaceRoot();
  if (!root) {
    process.stderr.write('  Not in a project directory.\n');
    process.exit(1);
  }

  const chalk = (await import('chalk')).default;

  // Quick scanning animation (~0.5s)
  const scanFrames = ['\u280B', '\u2819', '\u2838', '\u2834', '\u2826', '\u2807'];
  write('\n  ');
  for (let i = 0; i < 6; i++) {
    write(`\r  ${chalk.hex('#2d7d6f')(scanFrames[i]!)} Scanning...`);
    await sleep(60);
  }

  const data = collectVibeData(root);
  write('\r  \u2713 Done.          \n');
  await sleep(150);

  const mood = pickMood(data);
  const debtTotal = data.todoCount + data.fixmeCount + data.hackCount;

  const dim = chalk.dim;
  const accent = chalk.hex('#2d7d6f');
  const warn = chalk.yellow;

  // Title + mood (~0.3s)
  await animateLine('', 30);
  await animateLine(accent('  \u2728 Codebase Vibe Check \u2728'), 120);
  await animateLine('', 20);
  await animateLine(`  ${dim('Mood:')}        ${mood.emoji}  ${chalk.bold(mood.label)}`, 100);
  await animateLine('', 20);

  // Animated bars (~0.8s total — 15ms per bar char, 4 bars)
  const healthPct = Math.max(0, 100 - debtTotal * 2);
  await animateBar('Code Health', healthPct, 100, `${healthPct}%    ${dim(fileSizeComment(data.avgFileSize))}`, accent, dim);
  await animateBar('TODO Debt  ', debtTotal, 60, `${debtTotal}      ${dim(todoComment(data.todoCount))}`, warn, dim);
  await animateBar('Test Game  ', data.testCount, 50, `${data.testCount} files ${dim(testComment(data.testCount))}`, accent, dim);
  await animateBar('Commit Pace', data.commitsThisWeek, 40, `${data.commitsThisWeek}/week ${dim(commitComment(data.commitsThisWeek))}`, accent, dim);

  await animateLine('', 20);

  // Stats box — fast reveal (~0.3s)
  await animateLine(`  ${dim('\u250C\u2500 Quick Stats \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500')}`, 25);
  await animateLine(`  ${dim('\u2502')} ${data.totalFiles} files \u00B7 ${data.totalLines.toLocaleString()} lines \u00B7 ${data.languages.slice(0, 4).join(', ')}`, 25);
  if (data.largestFile) {
    await animateLine(`  ${dim('\u2502')} Largest file: ${data.largestFile.name} (${data.largestFile.lines} lines)`, 25);
  }
  if (data.topContributor) {
    await animateLine(`  ${dim('\u2502')} Top contributor: ${data.topContributor}`, 25);
  }
  if (data.nodeModulesSize) {
    await animateLine(`  ${dim('\u2502')} node_modules: ${data.nodeModulesSize} ${dim('"it\'s mostly pngs, right?"')}`, 25);
  }
  await animateLine(`  ${dim('\u2502')} CI: ${data.hasCi ? accent('\u2713 configured') : warn('none detected')}`, 25);
  await animateLine(`  ${dim('\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500')}`, 25);

  // Song + Fortune — short pauses for effect (~0.4s)
  await animateLine('', 20);
  write(`  ${dim('\u{1F3B5} If your codebase were a song:')}`);
  await sleep(200);
  await animateLine(` ${pickSong(data)}`, 80);
  await animateLine('', 20);
  write(`  ${dim('Fortune:')}`);
  await sleep(250);
  await animateLine(` ${pickFortune()}`);
  await animateLine('');
}
