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
    check('Node.js', () => {
      const version = process.version;
      const major = parseInt(version.slice(1).split('.')[0] ?? '0', 10);
      if (major < 20) {
        return Promise.resolve({ status: 'fail' as const, detail: `Node.js ${version} detected — upgrade to v20 or later` });
      }
      return Promise.resolve({ status: 'pass' as const, detail: `${version} — solid.` });
    }),

    // 2. Config file parse check
    check('Config', async () => {
      const config = await loadConfig(process.cwd(), options);
      return { status: 'pass' as const, detail: `using "${config.defaultProfile}" profile.` };
    }),

    // 3. Provider connectivity
    check('Provider', async () => {
      const config = await loadConfig(process.cwd(), options);
      const profile = getActiveProfile(config);
      const adapter = await createProvider(profile);
      await adapter.validateCredentials();
      const via = profile.provider === 'copilot' && process.env['JAM_VSCODE_LM_PORT']
        ? 'copilot (via VSCode)'
        : profile.provider;
      return { status: 'pass' as const, detail: `${via} connected and ready.` };
    }),

    // 4. Copilot CLI availability
    check('Copilot CLI', async () => {
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
    check('ripgrep', async () => {
      try {
        const { stdout } = await execFileAsync('rg', ['--version'], { timeout: 5000 });
        const firstLine = stdout.split('\n')[0]?.trim() ?? 'rg';
        return { status: 'pass' as const, detail: `${firstLine} — searches will be fast.` };
      } catch {
        return { status: 'warn' as const, detail: 'Not installed — searches will be slower without it' };
      }
    }),

    // 6. Keytar availability (optional)
    check('Keychain', async () => {
      try {
        await import('keytar');
        return { status: 'pass' as const, detail: 'secrets are secure.' };
      } catch {
        return {
          status: 'warn' as const,
          detail: 'Not available — use env vars for API keys',
        };
      }
    }),
  ]);

  process.stdout.write('\nChecking your setup...\n\n');

  for (const result of results) {
    let icon: string;
    if (result.status === 'pass') {
      icon = chalk.green('  ✓');
    } else if (result.status === 'warn') {
      icon = chalk.yellow('  !');
    } else {
      icon = chalk.red('  ✗');
    }
    const label = result.status === 'fail' ? chalk.red(result.description) : result.description;
    const detail = result.detail ? chalk.dim(` — ${result.detail}`) : '';
    process.stdout.write(`${icon} ${label}${detail}\n`);
  }

  process.stdout.write('\n');

  const failCount = results.filter((r) => r.status === 'fail').length;
  const warnCount = results.filter((r) => r.status === 'warn').length;

  if (failCount === 0 && warnCount === 0) {
    process.stdout.write(chalk.green('\nYou\'re good to go.\n'));
  } else if (failCount === 0) {
    process.stdout.write(chalk.green(`\nLooking good. ${warnCount} optional thing${warnCount === 1 ? '' : 's'} to improve.\n`));
  } else {
    process.stdout.write(chalk.yellow(`\n${failCount} issue${failCount === 1 ? '' : 's'} to fix.\n`));
  }

  // Show a random tip when things are looking good
  if (failCount === 0) {
    const { pickFortune } = await import('./vibes.js');
    process.stdout.write(chalk.dim(`\n  ${pickFortune()}\n`));
  }
}
