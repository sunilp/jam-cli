// src/agent/workspace-intel.ts

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { WorkspaceProfile } from './types.js';
import { analyzeConventions } from '../intel/conventions.js';
import type { ProviderAdapter } from '../providers/base.js';
import type { SerializedGraph } from '../intel/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

// ── Hash ──────────────────────────────────────────────────────────────────────

/**
 * Compute a deterministic SHA-256 hash over:
 *   - package.json / pyproject.toml / Cargo.toml content
 *   - sorted list of filenames in src/
 *   - config files: .eslintrc*, .prettierrc*, tsconfig.json, biome.json
 */
export async function computeProfileHash(root: string): Promise<string> {
  const hash = createHash('sha256');

  // Manifest files
  for (const name of ['package.json', 'pyproject.toml', 'Cargo.toml']) {
    const content = await readTextFile(join(root, name));
    if (content !== null) {
      hash.update(`${name}:${content}`);
    }
  }

  // Sorted list of file names in src/ (names only, not content)
  const srcEntries = await listDir(join(root, 'src'));
  hash.update(`src-files:${srcEntries.sort().join(',')}`);

  // Config files
  const configGlobs = [
    '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
    '.prettierrc', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.json', '.prettierrc.yml',
    'tsconfig.json', 'biome.json',
  ];
  for (const name of configGlobs) {
    const content = await readTextFile(join(root, name));
    if (content !== null) {
      hash.update(`${name}:${content}`);
    }
  }

  return hash.digest('hex');
}

// ── Cache ─────────────────────────────────────────────────────────────────────

type CachedProfile = WorkspaceProfile & { _hash: string };

function cacheFilePath(root: string): string {
  return join(root, '.jam', 'workspace-profile.json');
}

/**
 * Read `.jam/workspace-profile.json` and return the profile (with its stored
 * `_hash` field intact). Returns null if the file doesn't exist or is invalid.
 *
 * Hash validation is left to the caller (`buildWorkspaceProfile`) because
 * computing the hash is async — this function just does the sync disk read.
 */
export function loadCachedProfile(root: string): WorkspaceProfile | null {
  try {
    const raw = readFileSync(cacheFilePath(root), 'utf-8');
    return JSON.parse(raw) as CachedProfile;
  } catch {
    return null;
  }
}

async function saveProfileCache(root: string, profile: WorkspaceProfile, hash: string): Promise<void> {
  try {
    const dir = join(root, '.jam');
    await mkdir(dir, { recursive: true });
    const data: CachedProfile = { ...profile, _hash: hash };
    await writeFile(cacheFilePath(root), JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Cache write failures are non-fatal
  }
}

// ── Structural detection (static fallback) ────────────────────────────────────

async function detectFramework(root: string): Promise<string | undefined> {
  const pkgText = await readTextFile(join(root, 'package.json'));
  if (pkgText) {
    let pkg: Record<string, unknown> = {};
    try { pkg = JSON.parse(pkgText) as Record<string, unknown>; } catch { /* ignore */ }
    const deps = {
      ...((pkg.dependencies ?? {}) as Record<string, string>),
      ...((pkg.devDependencies ?? {}) as Record<string, string>),
    };
    // JS/TS frameworks
    if ('next' in deps) return 'next';
    if ('express' in deps) return 'express';
    if ('react' in deps) return 'react';
    if ('vue' in deps) return 'vue';
    if ('angular' in deps || '@angular/core' in deps) return 'angular';
  }

  // Python
  const pyproject = await readTextFile(join(root, 'pyproject.toml'));
  if (pyproject) {
    if (/fastapi/i.test(pyproject)) return 'fastapi';
    if (/flask/i.test(pyproject)) return 'flask';
    if (/django/i.test(pyproject)) return 'django';
  }
  const requirements = await readTextFile(join(root, 'requirements.txt'));
  if (requirements) {
    if (/fastapi/i.test(requirements)) return 'fastapi';
    if (/flask/i.test(requirements)) return 'flask';
    if (/django/i.test(requirements)) return 'django';
  }

  // Go
  const goMod = await readTextFile(join(root, 'go.mod'));
  if (goMod && /gin-gonic\/gin/.test(goMod)) return 'gin';

  // Rust
  const cargoToml = await readTextFile(join(root, 'Cargo.toml'));
  if (cargoToml && /actix-web/.test(cargoToml)) return 'actix';

  return undefined;
}

async function detectEntryPoints(root: string): Promise<string[]> {
  const candidates = [
    'src/index.ts', 'src/main.ts', 'src/app.ts',
    'main.py', 'main.go', 'src/main.rs',
  ];
  const found: string[] = [];
  await Promise.all(
    candidates.map(async (rel) => {
      try {
        await stat(join(root, rel));
        found.push(rel);
      } catch { /* file doesn't exist */ }
    }),
  );
  // Preserve original candidate order
  return candidates.filter(c => found.includes(c));
}

async function detectSrcLayout(root: string): Promise<string> {
  const topDirs = await listDir(root);
  if (topDirs.includes('src')) return 'src/';
  if (topDirs.includes('lib')) return 'lib/';
  if (topDirs.includes('app')) return 'app/';
  return 'flat';
}

async function detectMonorepo(root: string): Promise<boolean> {
  if (await isDir(join(root, 'packages'))) return true;
  if (await isDir(join(root, 'apps'))) return true;

  // Check for "workspaces" field in package.json
  const pkgText = await readTextFile(join(root, 'package.json'));
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as Record<string, unknown>;
      if ('workspaces' in pkg) return true;
    } catch { /* ignore */ }
  }
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build a complete WorkspaceProfile for the given root directory.
 *
 * Layer 1 — conventions (analyzeConventions)
 * Layer 2 — structural data from intel graph if available, else static detection
 *
 * Results are cached in `.jam/workspace-profile.json` keyed by a hash of
 * key project files.
 */
export async function buildWorkspaceProfile(
  root: string,
  _adapter?: ProviderAdapter,
): Promise<WorkspaceProfile> {
  // Compute hash first so we can validate the cache
  const hash = await computeProfileHash(root);

  // Check cache
  const cached = loadCachedProfile(root);
  if (cached) {
    const cachedWithHash = cached as CachedProfile;
    if (cachedWithHash._hash === hash) {
      // Return without the internal _hash field
      const { _hash: _discard, ...profile } = cachedWithHash;
      return profile as WorkspaceProfile;
    }
  }

  // Layer 1: conventions
  const conventions = await analyzeConventions(root);

  // Layer 2: structural data
  let framework: string | undefined;
  let entryPoints: string[] = [];

  // Try intel graph first
  const graphPath = join(root, '.jam', 'intel', 'graph.json');
  const graphText = await readTextFile(graphPath);
  if (graphText) {
    try {
      const graph = JSON.parse(graphText) as SerializedGraph;
      framework = graph.frameworks?.[0];
      // Derive entry points from graph nodes of type 'file' whose paths match
      // common entry point names
      const candidateNames = new Set(['index.ts', 'main.ts', 'app.ts', 'main.py', 'main.go', 'main.rs']);
      entryPoints = (graph.nodes ?? [])
        .filter(n => n.filePath && candidateNames.has(n.filePath.split('/').pop() ?? ''))
        .map(n => n.filePath!)
        .slice(0, 10);
    } catch { /* fall through to static */ }
  }

  // Static fallbacks when graph data is absent or incomplete
  if (!framework) {
    framework = await detectFramework(root);
  }
  if (entryPoints.length === 0) {
    entryPoints = await detectEntryPoints(root);
  }

  // These are always detected statically (graph doesn't encode them directly)
  const srcLayout = await detectSrcLayout(root);
  const monorepo = await detectMonorepo(root);

  const profile: WorkspaceProfile = {
    ...conventions,
    framework,
    entryPoints,
    srcLayout,
    monorepo,
  };

  // Persist cache
  await saveProfileCache(root, profile, hash);

  return profile;
}

// ── Prompt formatter ──────────────────────────────────────────────────────────

/**
 * Format a WorkspaceProfile as a concise human-readable string suitable for
 * injection into an agent system prompt.
 */
export function formatProfileForPrompt(profile: WorkspaceProfile): string {
  const lang = profile.language === 'typescript' ? 'TypeScript'
    : profile.language === 'javascript' ? 'JavaScript'
    : profile.language === 'python' ? 'Python'
    : profile.language === 'rust' ? 'Rust'
    : profile.language === 'go' ? 'Go'
    : profile.language;

  const frameworkPart = profile.framework ? `/${profile.framework}` : '';
  const header = `You are working in a ${lang}${frameworkPart} project.`;

  const style = profile.codeStyle;
  const indentDesc = style.indent === 'tabs' ? 'tabs' : `${style.indentSize}-space indent`;
  const quotesDesc = style.quotes === 'single' ? 'single quotes' : 'double quotes';
  const semiDesc = style.semicolons ? 'semicolons' : 'no semicolons';

  const lines: string[] = [
    header,
    `- Style: ${indentDesc}, ${quotesDesc}, ${semiDesc}, ${style.namingConvention}`,
    `- Files: ${profile.fileNaming} with ${profile.exportStyle} exports`,
    `- Imports: ${profile.importStyle} paths`,
    `- Errors: ${profile.errorHandling} pattern`,
    `- Tests: ${profile.testFramework}, ${profile.testLocation} ${profile.testNaming} files, ${profile.testStyle} style`,
    `- Run tests: ${profile.testCommand}`,
    `- Commits: ${profile.commitConvention}${profile.commitConvention === 'conventional' ? ' (feat:, fix:, chore:)' : ''}`,
  ];

  if (profile.entryPoints.length > 0) {
    lines.push(`- Entry points: ${profile.entryPoints.join(', ')}`);
  }
  if (profile.monorepo) {
    lines.push('- Monorepo: yes');
  }
  if (profile.linter) {
    lines.push(`- Linter: ${profile.linter}`);
  }
  if (profile.formatter) {
    lines.push(`- Formatter: ${profile.formatter}`);
  }

  return lines.join('\n');
}
