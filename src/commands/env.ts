/**
 * `jam env` — .env file manager.
 *
 * Diff .env vs .env.example, find missing vars, validate format,
 * redact for sharing. Zero LLM.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { getWorkspaceRoot } from '../utils/workspace.js';

interface EnvVar {
  key: string;
  value: string;
  line: number;
  comment?: string;
}

function parseEnvFile(content: string): EnvVar[] {
  const vars: EnvVar[] = [];
  const lines = content.split('\n');
  let pendingComment = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) { pendingComment = ''; continue; }
    if (line.startsWith('#')) {
      pendingComment = line.slice(1).trim();
      continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    vars.push({ key, value, line: i + 1, comment: pendingComment || undefined });
    pendingComment = '';
  }

  return vars;
}

/** Patterns that look like real secrets */
const SECRET_PATTERNS = [
  /password/i, /secret/i, /token/i, /key/i, /api_key/i,
  /private/i, /credential/i, /auth/i, /jwt/i, /bearer/i,
  /connection_string/i, /database_url/i, /dsn/i,
];

function isLikelySecret(key: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(key));
}

function redactValue(key: string, value: string): string {
  if (!value || value === 'true' || value === 'false' || value === '0' || value === '1') {
    return value;
  }
  if (isLikelySecret(key)) {
    return value.length > 4 ? value.slice(0, 2) + '*'.repeat(value.length - 4) + value.slice(-2) : '****';
  }
  // URLs: redact password part
  try {
    const url = new URL(value);
    if (url.password) {
      return value.replace(url.password, '****');
    }
  } catch { /* not a URL */ }

  return value;
}

export interface EnvOptions {
  diff?: boolean;
  missing?: boolean;
  redact?: boolean;
  validate?: boolean;
  json?: boolean;
  file?: string;
  example?: string;
}

export async function runEnv(options: EnvOptions): Promise<void> {
  const root = await getWorkspaceRoot().catch(() => process.cwd());

  // Auto-detect env files
  const envFile = options.file ?? '.env';
  const envPath = join(root, envFile);

  // Find example file
  const exampleCandidates = ['.env.example', '.env.sample', '.env.template', '.env.defaults'];
  const exampleFile = options.example ??
    exampleCandidates.find((f) => existsSync(join(root, f)));

  const hasEnv = existsSync(envPath);
  const hasExample = exampleFile ? existsSync(join(root, exampleFile)) : false;

  // List all env files in project root
  if (!options.diff && !options.missing && !options.redact && !options.validate) {
    const allEnvFiles = readdirSync(root).filter((f) => f.startsWith('.env'));
    if (allEnvFiles.length === 0) {
      process.stdout.write('No .env files found in project root.\n');
      return;
    }

    process.stdout.write(`\n${chalk.bold('Environment Files')}\n\n`);
    for (const f of allEnvFiles.sort()) {
      const full = join(root, f);
      const vars = parseEnvFile(readFileSync(full, 'utf-8'));
      const secrets = vars.filter((v) => isLikelySecret(v.key)).length;
      const empty = vars.filter((v) => !v.value).length;
      const secretTag = secrets > 0 ? chalk.red(` ${secrets} secrets`) : '';
      const emptyTag = empty > 0 ? chalk.yellow(` ${empty} empty`) : '';
      process.stdout.write(`  ${chalk.cyan(f.padEnd(22))} ${chalk.dim(`${vars.length} vars`)}${secretTag}${emptyTag}\n`);
    }
    process.stdout.write('\n');

    if (hasEnv && hasExample) {
      process.stdout.write(chalk.dim('Tip: jam env --diff to compare .env vs example, --missing to find gaps\n\n'));
    }
    return;
  }

  // ── Diff mode ──────────────────────────────────────────────────────────
  if (options.diff) {
    if (!hasEnv) { process.stderr.write(`${envFile} not found.\n`); process.exit(1); }
    if (!hasExample || !exampleFile) { process.stderr.write('No .env.example found.\n'); process.exit(1); }

    const envVars = parseEnvFile(readFileSync(envPath, 'utf-8'));
    const exampleVars = parseEnvFile(readFileSync(join(root, exampleFile), 'utf-8'));

    const envKeys = new Set(envVars.map((v) => v.key));
    const exampleKeys = new Set(exampleVars.map((v) => v.key));

    const missing = exampleVars.filter((v) => !envKeys.has(v.key));
    const extra = envVars.filter((v) => !exampleKeys.has(v.key));
    const common = envVars.filter((v) => exampleKeys.has(v.key));

    if (options.json) {
      process.stdout.write(JSON.stringify({
        missing: missing.map((v) => v.key),
        extra: extra.map((v) => v.key),
        common: common.map((v) => v.key),
      }, null, 2) + '\n');
      return;
    }

    process.stdout.write(`\n${chalk.bold('Env Diff')}: ${chalk.cyan(envFile)} vs ${chalk.cyan(exampleFile)}\n\n`);

    if (missing.length > 0) {
      process.stdout.write(`${chalk.red.bold('Missing')} ${chalk.dim(`(in ${exampleFile} but not ${envFile})`)}\n`);
      for (const v of missing) {
        const desc = v.comment ? chalk.dim(` # ${v.comment}`) : '';
        process.stdout.write(`  ${chalk.red('- ' + v.key)}${desc}\n`);
      }
      process.stdout.write('\n');
    }

    if (extra.length > 0) {
      process.stdout.write(`${chalk.yellow.bold('Extra')} ${chalk.dim(`(in ${envFile} but not ${exampleFile})`)}\n`);
      for (const v of extra) {
        process.stdout.write(`  ${chalk.yellow('+ ' + v.key)}\n`);
      }
      process.stdout.write('\n');
    }

    if (missing.length === 0 && extra.length === 0) {
      process.stdout.write(chalk.green('All variables match.\n\n'));
    }
    return;
  }

  // ── Missing mode ───────────────────────────────────────────────────────
  if (options.missing) {
    if (!hasEnv) { process.stderr.write(`${envFile} not found.\n`); process.exit(1); }

    const envVars = parseEnvFile(readFileSync(envPath, 'utf-8'));
    const empty = envVars.filter((v) => !v.value);

    if (options.json) {
      process.stdout.write(JSON.stringify(empty.map((v) => v.key), null, 2) + '\n');
      return;
    }

    if (empty.length === 0) {
      process.stdout.write(chalk.green('All variables have values.\n'));
      return;
    }

    process.stdout.write(`\n${chalk.yellow.bold('Empty Variables')} ${chalk.dim(`(${empty.length})`)}\n\n`);
    for (const v of empty) {
      const desc = v.comment ? chalk.dim(` # ${v.comment}`) : '';
      process.stdout.write(`  ${chalk.yellow(v.key)} ${chalk.dim(`line ${v.line}`)}${desc}\n`);
    }
    process.stdout.write('\n');
    return;
  }

  // ── Redact mode ────────────────────────────────────────────────────────
  if (options.redact) {
    if (!hasEnv) { process.stderr.write(`${envFile} not found.\n`); process.exit(1); }

    const envVars = parseEnvFile(readFileSync(envPath, 'utf-8'));

    if (options.json) {
      const redacted: Record<string, string> = {};
      for (const v of envVars) redacted[v.key] = redactValue(v.key, v.value);
      process.stdout.write(JSON.stringify(redacted, null, 2) + '\n');
      return;
    }

    process.stdout.write(`# Redacted ${envFile}\n`);
    for (const v of envVars) {
      if (v.comment) process.stdout.write(`# ${v.comment}\n`);
      const redacted = redactValue(v.key, v.value);
      const wasRedacted = redacted !== v.value;
      const line = `${v.key}=${redacted}`;
      process.stdout.write(wasRedacted ? chalk.yellow(line) + '\n' : line + '\n');
    }
    return;
  }

  // ── Validate mode ──────────────────────────────────────────────────────
  if (options.validate) {
    if (!hasEnv) { process.stderr.write(`${envFile} not found.\n`); process.exit(1); }

    const content = readFileSync(envPath, 'utf-8');
    const envVars = parseEnvFile(content);
    const issues: Array<{ line: number; key: string; issue: string }> = [];

    const seen = new Set<string>();
    for (const v of envVars) {
      // Duplicate keys
      if (seen.has(v.key)) {
        issues.push({ line: v.line, key: v.key, issue: 'duplicate key' });
      }
      seen.add(v.key);

      // Non-standard key names
      if (!/^[A-Z][A-Z0-9_]*$/.test(v.key) && !/^[a-z][a-z0-9_]*$/.test(v.key)) {
        issues.push({ line: v.line, key: v.key, issue: 'non-standard key format' });
      }

      // Empty secret values
      if (!v.value && isLikelySecret(v.key)) {
        issues.push({ line: v.line, key: v.key, issue: 'empty secret' });
      }

      // Unquoted values with spaces
      if (v.value.includes(' ') && !content.split('\n')[v.line - 1]!.includes('"')) {
        issues.push({ line: v.line, key: v.key, issue: 'unquoted value with spaces' });
      }
    }

    if (options.json) {
      process.stdout.write(JSON.stringify(issues, null, 2) + '\n');
      return;
    }

    if (issues.length === 0) {
      process.stdout.write(chalk.green(`${envFile} looks good. ${envVars.length} vars, no issues.\n`));
      return;
    }

    process.stdout.write(`\n${chalk.yellow.bold('Validation Issues')} ${chalk.dim(`(${issues.length})`)}\n\n`);
    for (const i of issues) {
      process.stdout.write(`  ${chalk.dim(`L${i.line}`)} ${chalk.yellow(i.key)} — ${i.issue}\n`);
    }
    process.stdout.write('\n');
    process.exit(issues.some((i) => i.issue === 'empty secret') ? 1 : 0);
  }
}
