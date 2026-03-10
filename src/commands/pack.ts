/**
 * `jam pack` — package/dependency analyzer.
 *
 * Size analysis, unused dep detection, duplicate deps,
 * and a nice project summary. Zero LLM.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { getWorkspaceRoot } from '../utils/workspace.js';

interface DepInfo {
  name: string;
  version: string;
  size: number;      // bytes on disk
  type: 'prod' | 'dev' | 'optional' | 'peer';
}

interface PkgJson {
  name?: string;
  version?: string;
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Recursively calculate directory size. */
function dirSize(dir: string): number {
  let total = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        total += dirSize(full);
      } else {
        try { total += statSync(full).size; } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return total;
}

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/** Find imports in source code to detect used dependencies. */
function findUsedPackages(root: string): Set<string> {
  const used = new Set<string>();
  try {
    const files = execSync('git ls-files --cached --others --exclude-standard', {
      cwd: root, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024,
    }).trim().split('\n').filter(Boolean);

    const codeFiles = files.filter((f) =>
      (f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.jsx') ||
       f.endsWith('.mjs') || f.endsWith('.cjs')) &&
      !f.includes('node_modules/') && !f.includes('dist/'),
    );

    for (const file of codeFiles) {
      try {
        const content = readFileSync(join(root, file), 'utf-8');
        // Match import/require of packages (not relative paths)
        const patterns = [
          /(?:import|export)\s+.*?from\s+['"]([^'"./][^'"]*)['"]/g,
          /require\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g,
        ];
        for (const pattern of patterns) {
          let match;
          while ((match = pattern.exec(content)) !== null) {
            const pkg = match[1]!;
            // Handle scoped packages: @scope/name
            const pkgName = pkg.startsWith('@')
              ? pkg.split('/').slice(0, 2).join('/')
              : pkg.split('/')[0]!;
            used.add(pkgName);
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* git not available */ }

  // Add common implicit dependencies
  used.add('typescript'); // used via tsconfig
  return used;
}

export interface PackOptions {
  unused?: boolean;
  size?: boolean;
  scripts?: boolean;
  json?: boolean;
}

export async function runPack(options: PackOptions): Promise<void> {
  const root = await getWorkspaceRoot().catch(() => process.cwd());
  const pkgPath = join(root, 'package.json');

  if (!existsSync(pkgPath)) {
    process.stderr.write('No package.json found.\n');
    process.exit(1);
    return;
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PkgJson;
  const nmPath = join(root, 'node_modules');
  const hasNm = existsSync(nmPath);

  const prodDeps = Object.keys(pkg.dependencies ?? {});
  const devDeps = Object.keys(pkg.devDependencies ?? {});
  const optDeps = Object.keys(pkg.optionalDependencies ?? {});
  const peerDeps = Object.keys(pkg.peerDependencies ?? {});
  const totalDeps = prodDeps.length + devDeps.length + optDeps.length + peerDeps.length;

  const showAll = !options.unused && !options.size && !options.scripts;

  // ── Summary ────────────────────────────────────────────────────────────
  if (showAll) {
    process.stdout.write(`\n${chalk.bold('Package Summary')}\n`);
    process.stdout.write(chalk.dim('─'.repeat(50)) + '\n');
    process.stdout.write(`  ${chalk.dim('Name:')}        ${chalk.bold(pkg.name ?? 'unnamed')}\n`);
    process.stdout.write(`  ${chalk.dim('Version:')}     ${pkg.version ?? '-'}\n`);
    if (pkg.description) {
      process.stdout.write(`  ${chalk.dim('Description:')} ${pkg.description}\n`);
    }
    process.stdout.write(`  ${chalk.dim('Dependencies:')} ${chalk.green(String(prodDeps.length))} prod, ${chalk.yellow(String(devDeps.length))} dev`);
    if (optDeps.length) process.stdout.write(`, ${chalk.cyan(String(optDeps.length))} optional`);
    if (peerDeps.length) process.stdout.write(`, ${chalk.magenta(String(peerDeps.length))} peer`);
    process.stdout.write('\n');

    if (hasNm) {
      const nmSize = dirSize(nmPath);
      process.stdout.write(`  ${chalk.dim('node_modules:')} ${chalk.bold(formatSize(nmSize))}\n`);

      // Count total installed packages
      try {
        const topLevel = readdirSync(nmPath).filter((f) => !f.startsWith('.'));
        let count = 0;
        for (const entry of topLevel) {
          if (entry.startsWith('@')) {
            count += readdirSync(join(nmPath, entry)).length;
          } else {
            count++;
          }
        }
        process.stdout.write(`  ${chalk.dim('Installed:')}   ${count} packages\n`);
      } catch { /* skip */ }
    }

    // Scripts
    const scripts = Object.keys(pkg.scripts ?? {});
    if (scripts.length > 0) {
      process.stdout.write(`\n${chalk.bold.cyan('Scripts')}\n`);
      for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
        process.stdout.write(`  ${chalk.yellow(name.padEnd(16))} ${chalk.dim(cmd)}\n`);
      }
    }
    process.stdout.write('\n');
  }

  // ── Size analysis ──────────────────────────────────────────────────────
  if (options.size || showAll) {
    if (!hasNm) {
      process.stdout.write(chalk.dim('Run npm install first for size analysis.\n\n'));
    } else {
      const depInfos: DepInfo[] = [];

      const addDeps = (deps: string[], type: DepInfo['type']) => {
        for (const name of deps) {
          const depPath = join(nmPath, name);
          if (existsSync(depPath)) {
            const size = dirSize(depPath);
            const version = (() => {
              try {
                const dpkg = JSON.parse(readFileSync(join(depPath, 'package.json'), 'utf-8')) as { version?: string };
                return dpkg.version ?? '?';
              } catch { return '?'; }
            })();
            depInfos.push({ name, version, size, type });
          }
        }
      };

      addDeps(prodDeps, 'prod');
      addDeps(devDeps, 'dev');

      depInfos.sort((a, b) => b.size - a.size);

      if (options.json && options.size) {
        process.stdout.write(JSON.stringify(depInfos, null, 2) + '\n');
        return;
      }

      if (depInfos.length > 0 && (options.size || showAll)) {
        const topN = options.size ? 25 : 10;
        process.stdout.write(`\n${chalk.bold.cyan('Largest Dependencies')}\n`);
        const maxSize = depInfos[0]!.size;
        for (const dep of depInfos.slice(0, topN)) {
          const barLen = Math.max(1, Math.round((dep.size / maxSize) * 20));
          const bar = (dep.type === 'dev' ? chalk.yellow : chalk.green)('█'.repeat(barLen));
          const typeTag = dep.type === 'dev' ? chalk.dim(' dev') : '';
          process.stdout.write(
            `  ${bar} ${formatSize(dep.size).padStart(8)}  ${dep.name}${chalk.dim(`@${dep.version}`)}${typeTag}\n`,
          );
        }
        process.stdout.write('\n');
      }
    }
  }

  // ── Unused detection ───────────────────────────────────────────────────
  if (options.unused || showAll) {
    const used = findUsedPackages(root);

    // Only check prod deps for unused (dev deps are tools, not imported)
    const unused = prodDeps.filter((d) => !used.has(d));

    // Also check if dev deps are actually used in code
    const unusedDev = devDeps.filter((d) => {
      // Common dev tools that aren't imported
      const toolPatterns = [
        'typescript', 'eslint', 'prettier', 'vitest', 'jest', 'mocha',
        'tsx', 'ts-node', 'nodemon', '@types/', 'lint-staged', 'husky',
        'turbo', 'webpack', 'vite', 'rollup', 'esbuild',
      ];
      return !toolPatterns.some((p) => d.startsWith(p)) && !used.has(d);
    });

    if (options.json && options.unused) {
      process.stdout.write(JSON.stringify({ unused, unusedDev }, null, 2) + '\n');
      return;
    }

    if (unused.length > 0 || unusedDev.length > 0) {
      process.stdout.write(`\n${chalk.yellow.bold('Potentially Unused')}\n`);
      if (unused.length > 0) {
        process.stdout.write(`  ${chalk.dim('Production:')}\n`);
        for (const d of unused) {
          process.stdout.write(`    ${chalk.yellow('?')} ${d}\n`);
        }
      }
      if (unusedDev.length > 0) {
        process.stdout.write(`  ${chalk.dim('Dev:')}\n`);
        for (const d of unusedDev) {
          process.stdout.write(`    ${chalk.dim('?')} ${d}\n`);
        }
      }
      process.stdout.write(chalk.dim('  (These may be used in config files or scripts)\n\n'));
    } else if (options.unused) {
      process.stdout.write(chalk.green('All dependencies appear to be used.\n'));
    }
  }

  // ── Scripts listing ────────────────────────────────────────────────────
  if (options.scripts) {
    const scripts = pkg.scripts ?? {};
    if (Object.keys(scripts).length === 0) {
      process.stdout.write('No scripts defined.\n');
      return;
    }

    if (options.json) {
      process.stdout.write(JSON.stringify(scripts, null, 2) + '\n');
      return;
    }

    process.stdout.write(`\n${chalk.bold('Scripts')}\n\n`);
    for (const [name, cmd] of Object.entries(scripts)) {
      process.stdout.write(`  ${chalk.yellow.bold(name)}\n    ${chalk.dim(cmd)}\n\n`);
    }
  }

  if (showAll && options.json) {
    process.stdout.write(JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      dependencies: { prod: prodDeps.length, dev: devDeps.length, optional: optDeps.length, peer: peerDeps.length, total: totalDeps },
      scripts: Object.keys(pkg.scripts ?? {}),
    }, null, 2) + '\n');
  }
}
