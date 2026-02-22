/**
 * JAM.md — persistent project context file.
 *
 * Automatically discovers project details (language, structure, dependencies,
 * patterns) and writes a `JAM.md` at the workspace root.  This file is read
 * by `jam ask` / `jam chat` and injected into the system prompt so the model
 * starts every conversation with a deep understanding of the project.
 *
 * Users can (and should) edit JAM.md to add domain-specific notes, coding
 * conventions, architectural decisions, etc.
 */

import { readFile, writeFile, readdir, access, constants } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Dirent } from 'node:fs';

export const CONTEXT_FILENAME = 'JAM.md';

// ── Read existing JAM.md ──────────────────────────────────────────────────────

/**
 * Load `JAM.md` from the workspace root.  Returns `null` if not found.
 */
export async function loadContextFile(workspaceRoot: string): Promise<string | null> {
  const contextPath = join(workspaceRoot, CONTEXT_FILENAME);
  try {
    return await readFile(contextPath, 'utf-8');
  } catch {
    return null;
  }
}

// ── Generate JAM.md ───────────────────────────────────────────────────────────

interface ProjectInfo {
  name: string;
  language: string;
  framework: string;
  packageManager: string;
  description: string;
  entryPoint: string;
  testFramework: string;
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
  structure: string;
}

/** Recursively build a directory tree string (max depth). */
async function buildTree(
  dir: string,
  prefix: string,
  depth: number,
  maxDepth: number,
): Promise<string> {
  if (depth > maxDepth) return '';

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return '';
  }

  // Filter out noise
  const filtered = entries
    .filter((e) => {
      const name = String(e.name);
      if (name.startsWith('.')) return false;
      if (['node_modules', 'dist', 'build', 'coverage', '__pycache__', '.next', '.nuxt', 'target', 'out'].includes(name)) return false;
      return true;
    })
    .sort((a, b) => {
      // Dirs first, then files
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return String(a.name).localeCompare(String(b.name));
    });

  const lines: string[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i]!;
    const name = String(entry.name);
    const isLast = i === filtered.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    if (entry.isDirectory()) {
      lines.push(`${prefix}${connector}${name}/`);
      const subtree = await buildTree(join(dir, name), prefix + childPrefix, depth + 1, maxDepth);
      if (subtree) lines.push(subtree);
    } else {
      lines.push(`${prefix}${connector}${name}`);
    }
  }

  return lines.join('\n');
}

/** Detect language, framework, and other details from filesystem. */
async function discoverProject(workspaceRoot: string): Promise<ProjectInfo> {
  const info: ProjectInfo = {
    name: basename(workspaceRoot),
    language: 'unknown',
    framework: 'none detected',
    packageManager: 'unknown',
    description: '',
    entryPoint: '',
    testFramework: '',
    scripts: {},
    dependencies: [],
    devDependencies: [],
    structure: '',
  };

  // ── package.json (Node / TS / JS) ──────────────────────────────────────────
  try {
    const pkgRaw = await readFile(join(workspaceRoot, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    info.name = (pkg['name'] as string) ?? info.name;
    info.description = (pkg['description'] as string) ?? '';
    info.entryPoint = (pkg['main'] as string) ?? (pkg['bin'] ? JSON.stringify(pkg['bin']) : '');

    const scripts = pkg['scripts'] as Record<string, string> | undefined;
    if (scripts) info.scripts = scripts;

    const deps = pkg['dependencies'] as Record<string, string> | undefined;
    if (deps) info.dependencies = Object.keys(deps);

    const devDeps = pkg['devDependencies'] as Record<string, string> | undefined;
    if (devDeps) info.devDependencies = Object.keys(devDeps);

    // Detect package manager
    const lockFiles: [string, string][] = [
      ['bun.lockb', 'bun'],
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
    ];
    for (const [file, mgr] of lockFiles) {
      try {
        await access(join(workspaceRoot, file), constants.F_OK);
        info.packageManager = mgr;
        break;
      } catch { /* skip */ }
    }

    // Detect frameworks from deps
    const allDeps = [...info.dependencies, ...info.devDependencies];
    if (allDeps.includes('commander') || allDeps.includes('yargs') || allDeps.includes('oclif'))
      info.framework = 'CLI application';
    else if (allDeps.includes('next')) info.framework = 'Next.js';
    else if (allDeps.includes('nuxt')) info.framework = 'Nuxt';
    else if (allDeps.includes('svelte')) info.framework = 'Svelte';
    else if (allDeps.includes('vue')) info.framework = 'Vue';
    else if (allDeps.includes('react')) info.framework = 'React';
    else if (allDeps.includes('express')) info.framework = 'Express';
    else if (allDeps.includes('fastify')) info.framework = 'Fastify';

    // Detect test framework
    if (allDeps.includes('vitest')) info.testFramework = 'Vitest';
    else if (allDeps.includes('jest')) info.testFramework = 'Jest';
    else if (allDeps.includes('mocha')) info.testFramework = 'Mocha';
  } catch { /* not a node project */ }

  // ── Language detection ──────────────────────────────────────────────────────
  try {
    await access(join(workspaceRoot, 'tsconfig.json'), constants.F_OK);
    info.language = 'TypeScript';
  } catch {
    try {
      await access(join(workspaceRoot, 'package.json'), constants.F_OK);
      info.language = 'JavaScript';
    } catch { /* fallthrough */ }
  }

  // Python detection
  if (info.language === 'unknown') {
    for (const marker of ['pyproject.toml', 'setup.py', 'requirements.txt', 'Pipfile']) {
      try {
        await access(join(workspaceRoot, marker), constants.F_OK);
        info.language = 'Python';
        break;
      } catch { /* skip */ }
    }
  }

  // Go
  if (info.language === 'unknown') {
    try {
      await access(join(workspaceRoot, 'go.mod'), constants.F_OK);
      info.language = 'Go';
    } catch { /* skip */ }
  }

  // Rust
  if (info.language === 'unknown') {
    try {
      await access(join(workspaceRoot, 'Cargo.toml'), constants.F_OK);
      info.language = 'Rust';
    } catch { /* skip */ }
  }

  // ── Build directory tree ───────────────────────────────────────────────────
  info.structure = await buildTree(workspaceRoot, '', 0, 3);

  return info;
}

/** File extension hint for the language. */
function langFileHint(lang: string): string {
  switch (lang) {
    case 'TypeScript': return '`.ts` / `.tsx`';
    case 'JavaScript': return '`.js` / `.jsx`';
    case 'Python': return '`.py`';
    case 'Go': return '`.go`';
    case 'Rust': return '`.rs`';
    default: return '';
  }
}

/**
 * Generate JAM.md content by auto-discovering the project.
 */
export async function generateContextContent(workspaceRoot: string): Promise<string> {
  const info = await discoverProject(workspaceRoot);

  const sections: string[] = [];

  // Header
  sections.push(`# ${info.name}`);
  sections.push('');
  sections.push('> This file was auto-generated by `jam context init`.');
  sections.push('> Edit it freely — Jam reads it on every `ask` / `chat` invocation.');
  sections.push('');

  // Overview
  sections.push('## Overview');
  sections.push('');
  if (info.description) sections.push(info.description);
  sections.push('');
  sections.push(`| Property | Value |`);
  sections.push(`|----------|-------|`);
  sections.push(`| Language | ${info.language} |`);
  if (langFileHint(info.language)) {
    sections.push(`| File extensions | ${langFileHint(info.language)} |`);
  }
  if (info.framework !== 'none detected') {
    sections.push(`| Framework | ${info.framework} |`);
  }
  if (info.packageManager !== 'unknown') {
    sections.push(`| Package manager | ${info.packageManager} |`);
  }
  if (info.entryPoint) {
    sections.push(`| Entry point | \`${info.entryPoint}\` |`);
  }
  if (info.testFramework) {
    sections.push(`| Test framework | ${info.testFramework} |`);
  }
  sections.push('');

  // Scripts
  if (Object.keys(info.scripts).length > 0) {
    sections.push('## Scripts');
    sections.push('');
    sections.push('```bash');
    for (const [name, cmd] of Object.entries(info.scripts)) {
      sections.push(`${info.packageManager !== 'unknown' ? info.packageManager : 'npm'} run ${name}  # ${cmd}`);
    }
    sections.push('```');
    sections.push('');
  }

  // Directory structure
  if (info.structure) {
    sections.push('## Directory Structure');
    sections.push('');
    sections.push('```');
    sections.push(info.structure);
    sections.push('```');
    sections.push('');
  }

  // Key dependencies
  if (info.dependencies.length > 0) {
    sections.push('## Key Dependencies');
    sections.push('');
    for (const dep of info.dependencies) {
      sections.push(`- \`${dep}\``);
    }
    sections.push('');
  }

  // Dev dependencies (abbreviated)
  if (info.devDependencies.length > 0) {
    sections.push('## Dev Dependencies');
    sections.push('');
    for (const dep of info.devDependencies) {
      sections.push(`- \`${dep}\``);
    }
    sections.push('');
  }

  // User editable sections
  sections.push('## Architecture Notes');
  sections.push('');
  sections.push('<!-- Add notes about the project architecture, key patterns, design decisions, etc. -->');
  sections.push('');

  sections.push('## Coding Conventions');
  sections.push('');
  sections.push('<!-- Add notes about coding style, naming conventions, import patterns, etc. -->');
  sections.push('');

  sections.push('## Important Context');
  sections.push('');
  sections.push('<!-- Add anything else Jam should know when answering questions about this project. -->');
  sections.push('');

  return sections.join('\n');
}

/**
 * Write JAM.md to the workspace root. Returns the path written.
 */
export async function writeContextFile(workspaceRoot: string, content: string): Promise<string> {
  const contextPath = join(workspaceRoot, CONTEXT_FILENAME);
  await writeFile(contextPath, content, 'utf-8');
  return contextPath;
}

/**
 * Check if JAM.md already exists.
 */
export async function contextFileExists(workspaceRoot: string): Promise<boolean> {
  try {
    await access(join(workspaceRoot, CONTEXT_FILENAME), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// ── Auto-update JAM.md with usage patterns (P2-7) ────────────────────────────

const USAGE_SECTION_HEADER = '## Frequently Accessed Files';
const USAGE_SECTION_MARKER = '<!-- jam-auto-usage -->';

/**
 * Update JAM.md with frequently accessed file patterns from the session.
 * Appends or replaces a "Frequently Accessed Files" section.
 *
 * @param workspaceRoot  Workspace root path
 * @param readFiles      Array of file paths accessed during sessions
 * @param searchQueries  Array of search queries used during sessions
 */
export async function updateContextWithUsage(
  workspaceRoot: string,
  readFiles: string[],
  searchQueries: string[],
): Promise<void> {
  const contextPath = join(workspaceRoot, CONTEXT_FILENAME);

  let existing: string;
  try {
    existing = await readFile(contextPath, 'utf-8');
  } catch {
    return; // No JAM.md — nothing to update
  }

  // Count file access frequency
  const fileCounts = new Map<string, number>();
  for (const f of readFiles) {
    fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
  }

  // Sort by frequency
  const topFiles = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([path, count]) => `- \`${path}\` (${count}x)`);

  if (topFiles.length === 0) return;

  const usageSection = [
    '',
    USAGE_SECTION_HEADER,
    '',
    USAGE_SECTION_MARKER,
    '',
    '> Auto-updated by Jam based on your usage patterns. These are the files most frequently',
    '> examined when answering questions. Jam will prioritize searching these locations.',
    '',
    ...topFiles,
    '',
    ...(searchQueries.length > 0 ? [
      '### Common Search Patterns',
      '',
      ...searchQueries.slice(0, 10).map(q => `- \`${q}\``),
      '',
    ] : []),
    USAGE_SECTION_MARKER,
    '',
  ].join('\n');

  // Replace existing usage section or append
  const markerStart = existing.indexOf(USAGE_SECTION_MARKER);
  if (markerStart !== -1) {
    const markerEnd = existing.indexOf(USAGE_SECTION_MARKER, markerStart + USAGE_SECTION_MARKER.length);
    if (markerEnd !== -1) {
      // Find the section header before first marker
      const headerPos = existing.lastIndexOf(USAGE_SECTION_HEADER, markerStart);
      const sectionStart = headerPos !== -1 ? headerPos : markerStart;
      const sectionEnd = markerEnd + USAGE_SECTION_MARKER.length;
      const updated = existing.slice(0, sectionStart) + usageSection + existing.slice(sectionEnd);
      await writeFile(contextPath, updated, 'utf-8');
      return;
    }
  }

  // Append to end
  const updated = existing.trimEnd() + '\n' + usageSection;
  await writeFile(contextPath, updated, 'utf-8');
}
