import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import type { CliOverrides } from '../config/schema.js';

const execFileAsync = promisify(execFile);

type CheckStatus = 'pass' | 'warn' | 'fail';

interface CheckResult {
  status: CheckStatus;
  description: string;
  detail: string;
}

async function check(
  description: string,
  fn: () => Promise<{ status: CheckStatus; detail: string }>
): Promise<CheckResult> {
  try {
    const result = await fn();
    return { description, ...result };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { status: 'fail', description, detail };
  }
}

export async function runDoctor(options: CliOverrides): Promise<void> {
  const chalk = (await import('chalk')).default;

  const results = await Promise.all([
    // 1. Node.js version check
    check('Node.js version >= 20', () => {
      const version = process.version;
      const major = parseInt(version.slice(1).split('.')[0] ?? '0', 10);
      if (major < 20) {
        return Promise.resolve({ status: 'fail' as const, detail: `Node.js ${version} detected — upgrade to v20 or later` });
      }
      return Promise.resolve({ status: 'pass' as const, detail: version });
    }),

    // 2. Config file parse check
    check('Config file is valid', async () => {
      const config = await loadConfig(process.cwd(), options);
      return { status: 'pass' as const, detail: `Active profile: "${config.defaultProfile}"` };
    }),

    // 3. Provider connectivity
    check('Provider connectivity', async () => {
      const config = await loadConfig(process.cwd(), options);
      const profile = getActiveProfile(config);
      const adapter = await createProvider(profile);
      await adapter.validateCredentials();
      const via = profile.provider === 'copilot' && process.env['JAM_VSCODE_LM_PORT']
        ? 'copilot (via VSCode)'
        : profile.provider;
      return { status: 'pass' as const, detail: `Provider: ${via}` };
    }),

    // 4. Copilot CLI availability
    check('Copilot CLI (@github/copilot)', async () => {
      try {
        const { stdout } = await execFileAsync('npx', ['@github/copilot', '--version'], { timeout: 15_000 });
        return { status: 'pass' as const, detail: stdout.trim() };
      } catch {
        return {
          status: 'warn' as const,
          detail: 'Not installed — tool calling disabled for copilot provider. Install: npm install -g @github/copilot',
        };
      }
    }),

    // 5. ripgrep availability (optional)
    check('ripgrep (rg) is available', async () => {
      try {
        const { stdout } = await execFileAsync('rg', ['--version'], { timeout: 5000 });
        const firstLine = stdout.split('\n')[0]?.trim() ?? 'rg';
        return { status: 'pass' as const, detail: firstLine };
      } catch {
        return { status: 'warn' as const, detail: 'Not installed — using JavaScript-based search (slower)' };
      }
    }),

    // 6. Keytar availability (optional)
    check('keytar (secure credential storage)', async () => {
      try {
        await import('keytar');
        return { status: 'pass' as const, detail: 'loaded' };
      } catch {
        return {
          status: 'warn' as const,
          detail: 'Not available — API keys must be provided via environment variables or config',
        };
      }
    }),
  ]);

  process.stdout.write('\nJam Doctor — system diagnostics\n');
  process.stdout.write(chalk.dim('─'.repeat(60) + '\n\n'));

  for (const result of results) {
    let icon: string;
    let label: string;
    if (result.status === 'pass') {
      icon = chalk.green('[✓]');
      label = chalk.green(result.description);
    } else if (result.status === 'warn') {
      icon = chalk.yellow('[!]');
      label = chalk.yellow(result.description);
    } else {
      icon = chalk.red('[✗]');
      label = chalk.red(result.description);
    }
    const detail = result.detail ? chalk.dim(` — ${result.detail}`) : '';
    process.stdout.write(`${icon} ${label}${detail}\n`);
  }

  process.stdout.write('\n');

  const failCount = results.filter((r) => r.status === 'fail').length;
  const warnCount = results.filter((r) => r.status === 'warn').length;

  if (failCount === 0 && warnCount === 0) {
    process.stdout.write(chalk.green('All checks passed.\n'));
  } else if (failCount === 0) {
    process.stdout.write(chalk.green(`All checks passed (${warnCount} optional).\n`));
  } else {
    process.stdout.write(
      chalk.yellow(`${failCount} check${failCount === 1 ? '' : 's'} failed, ${warnCount} optional.\n`)
    );
  }
}
