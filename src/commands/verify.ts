import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, constants, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { collectStream, withRetry } from '../utils/stream.js';
import { printError } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import type { CliOverrides } from '../config/schema.js';

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  message: string;
  details?: string;
  durationMs: number;
}

export interface VerifyReport {
  status: 'pass' | 'fail';
  risk: RiskLevel;
  riskScore: number;
  checks: CheckResult[];
  summary: string;
  diff: { filesChanged: number; insertions: number; deletions: number };
}

export interface VerifyOptions extends CliOverrides {
  staged?: boolean;
  base?: string;
  json?: boolean;
  failOnRisk?: RiskLevel;
  noAi?: boolean;
  noColor?: boolean;
  quiet?: boolean;
}

// ── Secret patterns ──────────────────────────────────────────────────────────

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'AWS Secret Key', pattern: /(?:aws_secret_access_key|secret_key)\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i },
  { name: 'Generic API Key', pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}["']?/i },
  { name: 'Generic Secret', pattern: /(?:secret|password|passwd|token)\s*[:=]\s*["'][^"']{8,}["']/i },
  { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'GitHub Token', pattern: /gh[ps]_[A-Za-z0-9_]{36,}/ },
  { name: 'Slack Token', pattern: /xox[bpors]-[A-Za-z0-9-]{10,}/ },
  { name: 'JWT', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'Anthropic API Key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API Key', pattern: /sk-[A-Za-z0-9]{20,}/ },
];

// ── Forbidden path patterns ──────────────────────────────────────────────────

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\.env(?:\.|$)/, reason: 'environment file with potential secrets' },
  { pattern: /credentials\.\w+$/, reason: 'credentials file' },
  { pattern: /(?:^|\/)\.ssh\//, reason: 'SSH directory' },
  { pattern: /id_rsa|id_ed25519|id_ecdsa/, reason: 'SSH private key' },
];

// ── Diff parsing ─────────────────────────────────────────────────────────────

interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
  addedLines: string[];
  changedFiles: string[];
}

function parseDiff(diff: string): DiffStats {
  const lines = diff.split('\n');
  let insertions = 0;
  let deletions = 0;
  const addedLines: string[] = [];
  const changedFiles = new Set<string>();

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      // Extract filename: diff --git a/foo b/foo
      const match = line.match(/diff --git a\/.+ b\/(.+)/);
      if (match) changedFiles.add(match[1]!);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      insertions++;
      addedLines.push(line.slice(1));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }

  return {
    filesChanged: changedFiles.size,
    insertions,
    deletions,
    addedLines,
    changedFiles: [...changedFiles],
  };
}

// ── Git helpers ──────────────────────────────────────────────────────────────

async function getDiff(cwd: string, options: VerifyOptions): Promise<string> {
  if (options.staged) {
    const { stdout } = await execFileAsync('git', ['diff', '--staged'], {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  }

  if (options.base) {
    // Diff against base branch
    let mergeBase: string;
    try {
      const { stdout } = await execFileAsync('git', ['merge-base', options.base, 'HEAD'], { cwd });
      mergeBase = stdout.trim();
    } catch {
      throw new JamError(
        `Could not find merge-base with "${options.base}". Does the branch exist?`,
        'TOOL_EXEC_ERROR'
      );
    }
    const { stdout } = await execFileAsync('git', ['diff', mergeBase, 'HEAD'], {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  }

  // Default: all uncommitted changes (staged + unstaged)
  const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

// ── Individual checks ────────────────────────────────────────────────────────

async function runCheck(
  name: string,
  fn: () => Promise<{ status: CheckResult['status']; message: string; details?: string }>
): Promise<CheckResult> {
  const start = Date.now();
  try {
    const result = await fn();
    return { name, ...result, durationMs: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { name, status: 'fail', message: msg, durationMs: Date.now() - start };
  }
}

function checkDiffSanity(stats: DiffStats): Promise<{ status: CheckResult['status']; message: string; details?: string }> {
  const issues: string[] = [];

  // Suspicious deletions: >3x more deletions than insertions
  if (stats.deletions > 50 && stats.deletions > stats.insertions * 3) {
    issues.push(`Suspicious deletion ratio: ${stats.deletions} deletions vs ${stats.insertions} insertions`);
  }

  // Too many files changed
  if (stats.filesChanged > 30) {
    issues.push(`Large changeset: ${stats.filesChanged} files changed (consider splitting)`);
  }

  // Forbidden file patterns
  for (const file of stats.changedFiles) {
    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      if (pattern.test(file)) {
        issues.push(`Forbidden file: ${file} (${reason})`);
      }
    }
  }

  if (issues.length > 0) {
    return Promise.resolve({
      status: 'warn' as const,
      message: `${issues.length} issue${issues.length > 1 ? 's' : ''} found`,
      details: issues.join('\n'),
    });
  }

  return Promise.resolve({
    status: 'pass' as const,
    message: `${stats.filesChanged} files, +${stats.insertions}/-${stats.deletions} lines`,
  });
}

function checkSecrets(addedLines: string[]): Promise<{ status: CheckResult['status']; message: string; details?: string }> {
  const findings: string[] = [];

  for (const line of addedLines) {
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        // Truncate the line for display
        const truncated = line.length > 80 ? line.slice(0, 80) + '...' : line;
        findings.push(`${name}: ${truncated}`);
      }
    }
  }

  if (findings.length > 0) {
    // Deduplicate
    const unique = [...new Set(findings)];
    return Promise.resolve({
      status: 'fail' as const,
      message: `${unique.length} potential secret${unique.length > 1 ? 's' : ''} detected`,
      details: unique.slice(0, 10).join('\n'),
    });
  }

  return Promise.resolve({
    status: 'pass' as const,
    message: 'No secrets detected in added lines',
  });
}

async function checkTypecheck(cwd: string): Promise<{ status: CheckResult['status']; message: string; details?: string }> {
  // Check if tsconfig.json exists
  try {
    await access(join(cwd, 'tsconfig.json'), constants.F_OK);
  } catch {
    return { status: 'skip', message: 'No tsconfig.json found' };
  }

  try {
    await execFileAsync('npx', ['tsc', '--noEmit'], {
      cwd,
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { status: 'pass', message: 'No type errors' };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const stdout = (err as { stdout?: string }).stdout ?? '';
    const output = (stdout + stderr).trim();
    const errorCount = (output.match(/error TS\d+/g) ?? []).length;
    return {
      status: 'fail',
      message: `${errorCount || 'Type'} error${errorCount !== 1 ? 's' : ''} found`,
      details: output.split('\n').slice(0, 20).join('\n'),
    };
  }
}

async function checkLint(cwd: string): Promise<{ status: CheckResult['status']; message: string; details?: string }> {
  // Detect lint script from package.json
  let lintCmd: string | null = null;
  try {
    const pkgRaw = await readFile(join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    if (pkg.scripts?.['lint']) {
      lintCmd = 'lint';
    } else if (pkg.scripts?.['lint:check']) {
      lintCmd = 'lint:check';
    }
  } catch {
    return { status: 'skip', message: 'No package.json found' };
  }

  if (!lintCmd) {
    return { status: 'skip', message: 'No lint script in package.json' };
  }

  try {
    await execFileAsync('npm', ['run', lintCmd], {
      cwd,
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { status: 'pass', message: 'Lint passed' };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const stdout = (err as { stdout?: string }).stdout ?? '';
    const output = (stdout + stderr).trim();
    const lines = output.split('\n');
    return {
      status: 'fail',
      message: 'Lint errors found',
      details: lines.slice(0, 20).join('\n'),
    };
  }
}

async function checkTests(cwd: string): Promise<{ status: CheckResult['status']; message: string; details?: string }> {
  // Detect test script
  let testCmd: string | null = null;
  try {
    const pkgRaw = await readFile(join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    if (pkg.scripts?.['test']) {
      testCmd = 'test';
    }
  } catch {
    return { status: 'skip', message: 'No package.json found' };
  }

  if (!testCmd) {
    return { status: 'skip', message: 'No test script in package.json' };
  }

  try {
    const { stdout, stderr } = await execFileAsync('npm', ['run', testCmd], {
      cwd,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    // Try to extract test count from common frameworks
    const output = stdout + stderr;
    const vitestMatch = output.match(/(\d+) passed/);
    const jestMatch = output.match(/Tests:\s+(\d+) passed/);
    const count = vitestMatch?.[1] ?? jestMatch?.[1] ?? '';
    return {
      status: 'pass',
      message: count ? `${count} tests passed` : 'All tests passed',
    };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const stdout = (err as { stdout?: string }).stdout ?? '';
    const output = (stdout + stderr).trim();
    const failMatch = output.match(/(\d+) failed/);
    const failCount = failMatch?.[1] ?? '';
    return {
      status: 'fail',
      message: failCount ? `${failCount} test${failCount !== '1' ? 's' : ''} failed` : 'Tests failed',
      details: output.split('\n').slice(-20).join('\n'),
    };
  }
}

async function checkAiRisk(
  diff: string,
  stats: DiffStats,
  cwd: string,
  options: VerifyOptions,
): Promise<{ status: CheckResult['status']; message: string; details?: string }> {
  const config = await loadConfig(cwd, options);
  const profile = getActiveProfile(config);
  const adapter = await createProvider(profile);

  const truncatedDiff = diff.length > 15000 ? diff.slice(0, 15000) + '\n... (truncated)' : diff;

  const prompt = [
    'You are a code review safety validator. Analyze this diff and respond with ONLY a JSON object (no markdown, no code fences):',
    '',
    '{"risk": "low|medium|high|critical", "score": 0.0-1.0, "findings": ["issue1", "issue2"], "summary": "one sentence"}',
    '',
    'Risk criteria:',
    '- low: cosmetic, docs, tests, config tweaks',
    '- medium: logic changes, new features, refactoring',
    '- high: auth/security changes, data model changes, API contract changes, dependency updates',
    '- critical: credential handling, payment logic, infrastructure changes, mass deletions',
    '',
    `Files changed: ${stats.changedFiles.join(', ')}`,
    `Stats: +${stats.insertions}/-${stats.deletions} across ${stats.filesChanged} files`,
    '',
    '```diff',
    truncatedDiff,
    '```',
  ].join('\n');

  const stream = withRetry(() =>
    adapter.streamCompletion({
      messages: [{ role: 'user', content: prompt }],
      model: profile.model,
      temperature: 0,
      maxTokens: 500,
    })
  );

  const { text } = await collectStream(stream);

  // Parse JSON from response (strip markdown fences if present)
  const jsonStr = text.replace(/```(?:json)?\n?/g, '').trim();
  let parsed: { risk?: string; score?: number; findings?: string[]; summary?: string };
  try {
    parsed = JSON.parse(jsonStr) as typeof parsed;
  } catch {
    // Try to extract JSON from the response
    const match = jsonStr.match(/\{[\s\S]*\}/);
    if (match) {
      parsed = JSON.parse(match[0]) as typeof parsed;
    } else {
      return { status: 'warn', message: 'AI review returned unparseable response', details: text };
    }
  }

  const risk = parsed.risk ?? 'medium';
  const score = typeof parsed.score === 'number' ? parsed.score : 0.5;
  const findings = parsed.findings ?? [];
  const summary = parsed.summary ?? 'No summary provided';

  const isHigh = risk === 'high' || risk === 'critical';

  return {
    status: isHigh ? 'warn' : 'pass',
    message: `Risk: ${risk} (${(score * 100).toFixed(0)}%) — ${summary}`,
    details: findings.length > 0 ? findings.map((f, i) => `${i + 1}. ${f}`).join('\n') : undefined,
  };
}

// ── Risk scoring ─────────────────────────────────────────────────────────────

const RISK_ORDER: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

function computeRisk(checks: CheckResult[]): { risk: RiskLevel; score: number } {
  let score = 0;

  for (const check of checks) {
    if (check.status === 'fail') {
      switch (check.name) {
        case 'secrets':
          score += 0.4;
          break;
        case 'typecheck':
          score += 0.2;
          break;
        case 'lint':
          score += 0.1;
          break;
        case 'tests':
          score += 0.25;
          break;
        default:
          score += 0.1;
      }
    } else if (check.status === 'warn') {
      if (check.name === 'ai-review') {
        // Extract score from AI review message
        const match = check.message.match(/\((\d+)%\)/);
        if (match) score += parseInt(match[1]!, 10) / 100 * 0.3;
        else score += 0.15;
      } else {
        score += 0.05;
      }
    }
  }

  score = Math.min(score, 1.0);

  let risk: RiskLevel;
  if (score < 0.2) risk = 'low';
  else if (score < 0.45) risk = 'medium';
  else if (score < 0.7) risk = 'high';
  else risk = 'critical';

  return { risk, score: Math.round(score * 100) / 100 };
}

function shouldFail(report: VerifyReport, threshold?: RiskLevel): boolean {
  if (!threshold) {
    // Default: fail on any check failure
    return report.checks.some((c) => c.status === 'fail');
  }
  const thresholdIdx = RISK_ORDER.indexOf(threshold);
  const reportIdx = RISK_ORDER.indexOf(report.risk);
  return reportIdx >= thresholdIdx;
}

// ── Output formatting ────────────────────────────────────────────────────────

async function printReport(report: VerifyReport, noColor: boolean): Promise<void> {
  const chalk = (await import('chalk')).default;
  if (noColor) chalk.level = 0;

  const write = (msg: string) => process.stdout.write(msg);

  write('\n');
  write(chalk.bold('  Jam Verify — Validation Report\n'));
  write(chalk.dim('  ' + '─'.repeat(56) + '\n'));
  write('\n');

  // Status + risk
  const statusIcon = report.status === 'pass' ? chalk.green('PASS') : chalk.red('FAIL');
  const riskColor =
    report.risk === 'low' ? chalk.green :
    report.risk === 'medium' ? chalk.yellow :
    report.risk === 'high' ? chalk.red :
    chalk.bgRed.white;

  write(`  Status: ${statusIcon}    Risk: ${riskColor(report.risk.toUpperCase())} (${(report.riskScore * 100).toFixed(0)}%)\n`);
  write(`  Files: ${report.diff.filesChanged}    +${report.diff.insertions}/-${report.diff.deletions} lines\n`);
  write('\n');

  // Checks
  for (const check of report.checks) {
    const icon =
      check.status === 'pass' ? chalk.green('[✓]') :
      check.status === 'fail' ? chalk.red('[✗]') :
      check.status === 'warn' ? chalk.yellow('[!]') :
      chalk.dim('[·]');

    const label =
      check.status === 'pass' ? chalk.green(check.name) :
      check.status === 'fail' ? chalk.red(check.name) :
      check.status === 'warn' ? chalk.yellow(check.name) :
      chalk.dim(check.name);

    const duration = chalk.dim(`${check.durationMs}ms`);

    write(`  ${icon} ${label} — ${check.message} ${duration}\n`);

    if (check.details && (check.status === 'fail' || check.status === 'warn')) {
      const indented = check.details
        .split('\n')
        .slice(0, 10)
        .map((l) => `      ${chalk.dim(l)}`)
        .join('\n');
      write(indented + '\n');
    }
  }

  write('\n');

  if (report.summary) {
    write(`  ${chalk.dim(report.summary)}\n`);
    write('\n');
  }

  write(chalk.dim('  ' + '─'.repeat(56) + '\n'));
  write('\n');
}

// ── Main command ─────────────────────────────────────────────────────────────

export async function runVerify(options: VerifyOptions): Promise<void> {
  const noColor = options.noColor ?? false;
  const stderrLog = options.quiet ? (_msg: string) => {} : (msg: string) => process.stderr.write(msg);

  try {
    const workspaceRoot = await getWorkspaceRoot();

    // Get diff
    stderrLog('Getting diff...\n');
    const diff = await getDiff(workspaceRoot, options);

    if (!diff) {
      if (options.json) {
        process.stdout.write(JSON.stringify({ status: 'pass', risk: 'low', riskScore: 0, checks: [], summary: 'No changes to verify', diff: { filesChanged: 0, insertions: 0, deletions: 0 } }, null, 2) + '\n');
      } else {
        process.stdout.write('No changes to verify.\n');
      }
      return;
    }

    const stats = parseDiff(diff);
    stderrLog(`Found ${stats.filesChanged} changed files (+${stats.insertions}/-${stats.deletions})\n`);

    // Run checks — parallel where possible
    stderrLog('Running checks...\n');

    // Fast checks run in parallel
    const [diffSanity, secrets] = await Promise.all([
      runCheck('diff-sanity', () => checkDiffSanity(stats)),
      runCheck('secrets', () => checkSecrets(stats.addedLines)),
    ]);

    // Heavier checks run in parallel
    const [typecheck, lint, tests] = await Promise.all([
      runCheck('typecheck', () => checkTypecheck(workspaceRoot)),
      runCheck('lint', () => checkLint(workspaceRoot)),
      runCheck('tests', () => checkTests(workspaceRoot)),
    ]);

    const checks: CheckResult[] = [diffSanity, secrets, typecheck, lint, tests];

    // AI review (optional, runs last)
    if (!options.noAi) {
      stderrLog('Running AI risk assessment...\n');
      const aiCheck = await runCheck('ai-review', () =>
        checkAiRisk(diff, stats, process.cwd(), options)
      );
      checks.push(aiCheck);
    }

    // Compute overall risk
    const { risk, score } = computeRisk(checks);
    const anyFail = checks.some((c) => c.status === 'fail');

    // Build summary
    const passed = checks.filter((c) => c.status === 'pass').length;
    const failed = checks.filter((c) => c.status === 'fail').length;
    const warned = checks.filter((c) => c.status === 'warn').length;
    const skipped = checks.filter((c) => c.status === 'skip').length;
    const summaryParts = [`${passed} passed`];
    if (failed > 0) summaryParts.push(`${failed} failed`);
    if (warned > 0) summaryParts.push(`${warned} warnings`);
    if (skipped > 0) summaryParts.push(`${skipped} skipped`);

    const report: VerifyReport = {
      status: anyFail ? 'fail' : 'pass',
      risk,
      riskScore: score,
      checks,
      summary: summaryParts.join(', '),
      diff: {
        filesChanged: stats.filesChanged,
        insertions: stats.insertions,
        deletions: stats.deletions,
      },
    };

    // Output
    if (options.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      await printReport(report, noColor);
    }

    // Exit code
    if (shouldFail(report, options.failOnRisk)) {
      process.exit(1);
    }
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}
