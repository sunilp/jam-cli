// src/intel/conventions.ts

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspaceProfile } from '../agent/types.js';

const execAsync = promisify(exec);

/** Partial WorkspaceProfile with convention/style fields only.
 *  Structural fields (framework, entryPoints) come from intel graph. */
export type ConventionProfile = Omit<WorkspaceProfile,
  'framework' | 'entryPoints' | 'monorepo' | 'srcLayout'>;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return null;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Collect up to `max` source files by walking directories recursively. */
async function collectSourceFiles(root: string, max: number): Promise<string[]> {
  const sourceExts = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs']);
  const skipDirs = new Set(['.git', 'node_modules', '.jam', 'dist', 'build', '.next', '.cache', 'coverage']);
  // Prefer entry points that look like typical module files (not index or CLI entry)
  const skipNames = new Set(['index.ts', 'index.js', 'index.tsx', 'index.jsx']);
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    if (files.length >= max) return;
    const entries = await listDir(dir);
    const fileEntries: string[] = [];
    const dirEntries: string[] = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      if (await isDir(fullPath)) {
        if (!skipDirs.has(entry)) dirEntries.push(fullPath);
      } else {
        fileEntries.push(entry);
      }
    }
    // Add non-test source files from this dir first
    for (const entry of fileEntries) {
      if (files.length >= max) return;
      const ext = extname(entry);
      if (!sourceExts.has(ext)) continue;
      if (/\.(test|spec)\.[a-z]+$/.test(entry)) continue;
      if (skipNames.has(entry)) continue;
      files.push(join(dir, entry));
    }
    // Then recurse into subdirectories
    for (const subDir of dirEntries) {
      if (files.length >= max) return;
      await walk(subDir);
    }
  }

  // Walk src/, then lib/, then root as fallback
  const candidates = ['src', 'lib', '.'];
  for (const dir of candidates) {
    if (files.length >= max) break;
    const fullDir = dir === '.' ? root : join(root, dir);
    if (!(await isDir(fullDir))) continue;
    await walk(fullDir);
  }

  return files.slice(0, max);
}

// ── Language & Tooling ────────────────────────────────────────────────────────

interface ToolingInfo {
  language: string;
  packageManager: string;
  testFramework: string;
  testCommand: string;
  linter?: string;
  formatter?: string;
  typeChecker?: string;
  buildTool?: string;
}

async function detectTooling(root: string): Promise<ToolingInfo> {
  let language = 'javascript';
  let packageManager = 'npm';
  let testFramework = 'unknown';
  let testCommand = 'npm test';
  let linter: string | undefined;
  let formatter: string | undefined;
  let typeChecker: string | undefined;
  let buildTool: string | undefined;

  // package.json — JS/TS
  const pkgText = await readTextFile(join(root, 'package.json'));
  if (pkgText) {
    let pkg: Record<string, unknown> = {};
    try { pkg = JSON.parse(pkgText); } catch { /* ignore */ }

    const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
    const deps = (pkg.dependencies ?? {}) as Record<string, string>;
    const allDeps = { ...deps, ...devDeps };
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;

    // Language
    if ('typescript' in allDeps) {
      language = 'typescript';
      typeChecker = 'typescript';
    }

    // Package manager — check lockfiles
    const [yarnLock, pnpmLock, bunLock] = await Promise.all([
      readTextFile(join(root, 'yarn.lock')),
      readTextFile(join(root, 'pnpm-lock.yaml')),
      readTextFile(join(root, 'bun.lockb')).then(v => v).catch(() => null),
    ]);
    const packageManagerField = (pkg.packageManager as string | undefined) ?? '';
    if (packageManagerField.startsWith('yarn') || yarnLock !== null) {
      packageManager = 'yarn';
    } else if (packageManagerField.startsWith('pnpm') || pnpmLock !== null) {
      packageManager = 'pnpm';
    } else if (packageManagerField.startsWith('bun') || bunLock !== null) {
      packageManager = 'bun';
    }

    // Test framework
    if ('vitest' in allDeps) {
      testFramework = 'vitest';
    } else if ('jest' in allDeps || '@jest/core' in allDeps) {
      testFramework = 'jest';
    } else if ('mocha' in allDeps) {
      testFramework = 'mocha';
    }

    // Test command — look at scripts
    const testScript = scripts['test'] ?? '';
    if (testScript) {
      testCommand = `${packageManager === 'npm' ? 'npm' : packageManager} run test`;
      if (testScript.includes('vitest')) testCommand = 'npx vitest run';
      else if (testScript.includes('jest')) testCommand = 'npx jest';
    }

    // Linter
    if ('eslint' in allDeps) linter = 'eslint';
    else if ('biome' in allDeps || '@biomejs/biome' in allDeps) linter = 'biome';
    else if ('oxlint' in allDeps) linter = 'oxlint';

    // Formatter
    if ('prettier' in allDeps) formatter = 'prettier';
    else if ('biome' in allDeps || '@biomejs/biome' in allDeps) formatter = formatter ?? 'biome';

    // Build tool
    if ('tsup' in allDeps) buildTool = 'tsup';
    else if ('vite' in allDeps) buildTool = 'vite';
    else if ('esbuild' in allDeps) buildTool = 'esbuild';
    else if ('webpack' in allDeps) buildTool = 'webpack';
    else if ('rollup' in allDeps) buildTool = 'rollup';
  }

  // pyproject.toml — Python
  const pyproject = await readTextFile(join(root, 'pyproject.toml'));
  if (pyproject && !pkgText) {
    language = 'python';
    if (pyproject.includes('pytest')) testFramework = 'pytest';
    testCommand = 'pytest';
  }

  // Cargo.toml — Rust
  const cargoToml = await readTextFile(join(root, 'Cargo.toml'));
  if (cargoToml && !pkgText && !pyproject) {
    language = 'rust';
    testFramework = 'cargo-test';
    testCommand = 'cargo test';
  }

  // go.mod — Go
  const goMod = await readTextFile(join(root, 'go.mod'));
  if (goMod && !pkgText && !pyproject && !cargoToml) {
    language = 'go';
    testFramework = 'go-test';
    testCommand = 'go test ./...';
  }

  return { language, packageManager, testFramework, testCommand, linter, formatter, typeChecker, buildTool };
}

// ── Code Style ────────────────────────────────────────────────────────────────

interface StyleVote {
  tabs: number;
  spaces: number;
  indentSizes: number[];
  singleQuote: number;
  doubleQuote: number;
  semiLines: number;
  noSemiLines: number;
  trailingCommaCount: number;
  noTrailingCommaCount: number;
  camelCase: number;
  snakeCase: number;
  pascalCase: number;
}

function analyzeFileStyle(content: string): StyleVote {
  const lines = content.split('\n');
  const vote: StyleVote = {
    tabs: 0,
    spaces: 0,
    indentSizes: [],
    singleQuote: 0,
    doubleQuote: 0,
    semiLines: 0,
    noSemiLines: 0,
    trailingCommaCount: 0,
    noTrailingCommaCount: 0,
    camelCase: 0,
    snakeCase: 0,
    pascalCase: 0,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip empty lines and comment lines
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
      continue;
    }

    // Indentation
    if (line !== trimmed) {
      const leadingWhitespace = line.slice(0, line.length - trimmed.length);
      if (leadingWhitespace.includes('\t')) {
        vote.tabs++;
      } else {
        vote.spaces++;
        const size = leadingWhitespace.length;
        if (size > 0) vote.indentSizes.push(size);
      }
    }

    // Quotes — skip lines that are likely import paths or template literals
    const noStrings = trimmed.replace(/`[^`]*`/g, '');
    const singleMatches = (noStrings.match(/'[^'\\n]{1,80}'/g) ?? []).length;
    const doubleMatches = (noStrings.match(/"[^"\\n]{1,80}"/g) ?? []).length;
    vote.singleQuote += singleMatches;
    vote.doubleQuote += doubleMatches;

    // Semicolons — lines ending with ;
    // Only count lines that look like complete statements (not method chain continuations)
    const stripped = trimmed.replace(/\/\/.*$/, '').trimEnd();
    const isChainContinuation = stripped.startsWith('.');
    if (stripped.endsWith(';')) {
      vote.semiLines++;
    } else if (
      !isChainContinuation &&
      stripped.length > 0 &&
      !stripped.endsWith('{') &&
      !stripped.endsWith('}') &&
      !stripped.endsWith(',') &&
      !stripped.endsWith('(') &&
      !stripped.endsWith(':') &&
      !stripped.endsWith('|') &&
      !stripped.endsWith('&') &&
      !stripped.endsWith('\\') &&
      !stripped.endsWith(')')
    ) {
      vote.noSemiLines++;
    }

    // Trailing commas — lines ending with , followed by } or ] on next line
    if (stripped.endsWith(',') && i + 1 < lines.length) {
      const nextTrimmed = lines[i + 1].trim();
      if (nextTrimmed.startsWith('}') || nextTrimmed.startsWith(']') || nextTrimmed.startsWith(')')) {
        vote.trailingCommaCount++;
      }
    }

    // Naming convention — const/let/var/function declarations
    const camelMatch = trimmed.match(/(?:const|let|var|function)\s+([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)/);
    const snakeMatch = trimmed.match(/(?:const|let|var|function)\s+([a-z][a-z0-9]*_[a-z][a-z0-9_]*)/);
    const pascalMatch = trimmed.match(/(?:const|let|var|function)\s+([A-Z][a-zA-Z0-9]+)/);
    if (camelMatch) vote.camelCase++;
    if (snakeMatch) vote.snakeCase++;
    if (pascalMatch) vote.pascalCase++;
  }

  return vote;
}

interface CodeStyle {
  indent: 'tabs' | 'spaces';
  indentSize: number;
  quotes: 'single' | 'double';
  semicolons: boolean;
  trailingCommas: boolean;
  namingConvention: 'camelCase' | 'snake_case' | 'PascalCase';
}

async function detectCodeStyle(root: string): Promise<CodeStyle> {
  const files = await collectSourceFiles(root, 5);

  const totals: StyleVote = {
    tabs: 0,
    spaces: 0,
    indentSizes: [],
    singleQuote: 0,
    doubleQuote: 0,
    semiLines: 0,
    noSemiLines: 0,
    trailingCommaCount: 0,
    noTrailingCommaCount: 0,
    camelCase: 0,
    snakeCase: 0,
    pascalCase: 0,
  };

  for (const file of files) {
    const content = await readTextFile(file);
    if (!content) continue;
    const vote = analyzeFileStyle(content);
    totals.tabs += vote.tabs;
    totals.spaces += vote.spaces;
    totals.indentSizes.push(...vote.indentSizes);
    totals.singleQuote += vote.singleQuote;
    totals.doubleQuote += vote.doubleQuote;
    totals.semiLines += vote.semiLines;
    totals.noSemiLines += vote.noSemiLines;
    totals.trailingCommaCount += vote.trailingCommaCount;
    totals.noTrailingCommaCount += vote.noTrailingCommaCount;
    totals.camelCase += vote.camelCase;
    totals.snakeCase += vote.snakeCase;
    totals.pascalCase += vote.pascalCase;
  }

  // Indent type
  const indent: 'tabs' | 'spaces' = totals.tabs > totals.spaces ? 'tabs' : 'spaces';

  // Indent size — find the GCD or most common small size
  let indentSize = 2;
  if (totals.indentSizes.length > 0) {
    const sizeCounts = new Map<number, number>();
    for (const s of totals.indentSizes) {
      if (s > 0 && s <= 8) {
        sizeCounts.set(s, (sizeCounts.get(s) ?? 0) + 1);
      }
    }
    // Most common indent sizes are multiples of the base; find the smallest common factor
    const smallSizes = [2, 4, 3, 8];
    let bestSize = 2;
    let bestCount = 0;
    for (const sz of smallSizes) {
      let count = 0;
      for (const [s, c] of sizeCounts) {
        if (s % sz === 0) count += c;
      }
      if (count > bestCount) {
        bestCount = count;
        bestSize = sz;
      }
    }
    indentSize = bestSize;
  }

  // Quotes
  const quotes: 'single' | 'double' = totals.singleQuote >= totals.doubleQuote ? 'single' : 'double';

  // Semicolons
  const semicolons = totals.semiLines >= totals.noSemiLines;

  // Trailing commas
  const trailingCommas = totals.trailingCommaCount > totals.noTrailingCommaCount;

  // Naming convention
  let namingConvention: 'camelCase' | 'snake_case' | 'PascalCase' = 'camelCase';
  const maxNaming = Math.max(totals.camelCase, totals.snakeCase, totals.pascalCase);
  if (maxNaming === totals.snakeCase) namingConvention = 'snake_case';
  else if (maxNaming === totals.pascalCase) namingConvention = 'PascalCase';

  return { indent, indentSize, quotes, semicolons, trailingCommas, namingConvention };
}

// ── File Naming ───────────────────────────────────────────────────────────────

async function detectFileNaming(root: string): Promise<string> {
  const dirs = ['src', 'lib', '.'];
  const counts = { kebab: 0, camel: 0, pascal: 0, snake: 0 };

  for (const dir of dirs) {
    const fullDir = dir === '.' ? root : join(root, dir);
    const entries = await listDir(fullDir);
    for (const entry of entries) {
      const name = basename(entry, extname(entry));
      if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) counts.kebab++;
      else if (/^[a-z][a-zA-Z0-9]+$/.test(name)) counts.camel++;
      else if (/^[A-Z][a-zA-Z0-9]+$/.test(name)) counts.pascal++;
      else if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) counts.snake++;
    }
  }

  const max = Math.max(counts.kebab, counts.camel, counts.pascal, counts.snake);
  if (max === counts.pascal) return 'PascalCase';
  if (max === counts.camel) return 'camelCase';
  if (max === counts.snake) return 'snake_case';
  return 'kebab-case';
}

// ── Export Style ──────────────────────────────────────────────────────────────

async function detectExportStyle(root: string): Promise<'named' | 'default' | 'barrel'> {
  // Check for barrel exports (index.ts/js files)
  const srcDir = join(root, 'src');
  const entries = await listDir(srcDir);
  const hasBarrel = entries.some(e => e === 'index.ts' || e === 'index.js' || e === 'index.tsx');
  if (hasBarrel) return 'barrel';

  // Sample a few files for default vs named
  const files = await collectSourceFiles(root, 5);
  let defaultCount = 0;
  let namedCount = 0;
  for (const file of files) {
    const content = await readTextFile(file);
    if (!content) continue;
    if (/^export default /m.test(content)) defaultCount++;
    if (/^export (?:const|function|class|interface|type|enum) /m.test(content)) namedCount++;
  }

  return defaultCount > namedCount ? 'default' : 'named';
}

// ── Import Style ──────────────────────────────────────────────────────────────

async function detectImportStyle(root: string): Promise<'relative' | 'alias'> {
  const files = await collectSourceFiles(root, 5);
  let aliasCount = 0;
  let relativeCount = 0;

  for (const file of files) {
    const content = await readTextFile(file);
    if (!content) continue;
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.includes('import')) continue;
      if (/from ['"](@\/|~\/|#)/.test(line)) aliasCount++;
      else if (/from ['"](\.\.\.|\.\/|\.\.\/)/.test(line)) relativeCount++;
    }
  }

  return aliasCount > relativeCount ? 'alias' : 'relative';
}

// ── Test Patterns ─────────────────────────────────────────────────────────────

interface TestInfo {
  testLocation: string;
  testNaming: string;
  testStyle: string;
}

async function detectTestPatterns(root: string): Promise<TestInfo> {
  // Check for dedicated test directories
  const testDirs = ['tests', '__tests__', 'test', 'spec'];
  for (const dir of testDirs) {
    if (await isDir(join(root, dir))) {
      // Determine naming pattern inside
      const entries = await listDir(join(root, dir));
      const hasSpec = entries.some(e => e.includes('.spec.'));
      const naming = hasSpec ? '*.spec.ts' : '*.test.ts';
      return {
        testLocation: dir,
        testNaming: naming,
        testStyle: 'dedicated-directory',
      };
    }
    if (await isDir(join(root, 'src', dir))) {
      const entries = await listDir(join(root, 'src', dir));
      const hasSpec = entries.some(e => e.includes('.spec.'));
      const naming = hasSpec ? '*.spec.ts' : '*.test.ts';
      return {
        testLocation: `src/${dir}`,
        testNaming: naming,
        testStyle: 'dedicated-directory',
      };
    }
  }

  // Check for co-located tests
  const srcEntries = await listDir(join(root, 'src'));
  const hasTestTs = srcEntries.some(e => e.endsWith('.test.ts') || e.endsWith('.test.tsx'));
  const hasSpecTs = srcEntries.some(e => e.endsWith('.spec.ts') || e.endsWith('.spec.tsx'));
  if (hasTestTs || hasSpecTs) {
    return {
      testLocation: 'co-located',
      testNaming: hasSpecTs ? '*.spec.ts' : '*.test.ts',
      testStyle: 'co-located',
    };
  }

  return {
    testLocation: 'unknown',
    testNaming: '*.test.ts',
    testStyle: 'unknown',
  };
}

// ── Git Conventions ───────────────────────────────────────────────────────────

interface GitInfo {
  commitConvention: string;
  branchPattern: string;
}

async function detectGitConventions(root: string): Promise<GitInfo> {
  let commitConvention = 'unknown';
  let branchPattern = 'unknown';

  try {
    const { stdout: logOut } = await execAsync('git log --oneline -20', { cwd: root });
    const commits = logOut.split('\n').filter(Boolean);
    const conventionalPattern = /^[0-9a-f]+ (feat|fix|chore|docs|style|refactor|test|perf|ci|build|revert)(\(.+?\))?:/;
    const conventionalCount = commits.filter(c => conventionalPattern.test(c)).length;
    if (conventionalCount >= commits.length * 0.5 && conventionalCount > 0) {
      commitConvention = 'conventional';
    } else {
      commitConvention = 'freeform';
    }
  } catch {
    // not a git repo or no commits
  }

  try {
    const { stdout: branchOut } = await execAsync('git branch -a', { cwd: root });
    const branches = branchOut.split('\n').map(b => b.trim().replace(/^\* /, '')).filter(Boolean);
    // Check for common patterns
    const featurePattern = branches.filter(b => /^(feat|feature)\//.test(b)).length;
    const gitflowPattern = branches.filter(b => /^(develop|release\/|hotfix\/)/.test(b)).length;
    if (featurePattern > 0) branchPattern = 'feat/<name>';
    else if (gitflowPattern > 0) branchPattern = 'gitflow';
    else branchPattern = '<type>/<name>';
  } catch {
    // not a git repo
  }

  return { commitConvention, branchPattern };
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function analyzeConventions(root: string): Promise<ConventionProfile> {
  const [tooling, codeStyle, fileNaming, exportStyle, importStyle, testPatterns, gitInfo] =
    await Promise.all([
      detectTooling(root),
      detectCodeStyle(root),
      detectFileNaming(root),
      detectExportStyle(root),
      detectImportStyle(root),
      detectTestPatterns(root),
      detectGitConventions(root),
    ]);

  return {
    language: tooling.language,
    packageManager: tooling.packageManager,
    testFramework: tooling.testFramework,
    testCommand: tooling.testCommand,
    linter: tooling.linter,
    formatter: tooling.formatter,
    typeChecker: tooling.typeChecker,
    buildTool: tooling.buildTool,
    codeStyle,
    fileNaming,
    exportStyle,
    importStyle: importStyle,
    testLocation: testPatterns.testLocation,
    testNaming: testPatterns.testNaming,
    testStyle: testPatterns.testStyle,
    commitConvention: gitInfo.commitConvention,
    branchPattern: gitInfo.branchPattern,
    // Sensible defaults for fields not directly detectable here
    errorHandling: 'try-catch',
    logging: 'console',
    configPattern: 'config-file',
  };
}
