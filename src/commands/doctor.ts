import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import type { CliOverrides } from '../config/schema.js';

const execFileAsync = promisify(execFile);

async function check(
  description: string,
  fn: () => Promise<string | void>
): Promise<{ ok: boolean; description: string; detail: string }> {
  try {
    const detail = (await fn()) ?? '';
    return { ok: true, description, detail: String(detail) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, description, detail };
  }
}

export async function runDoctor(options: CliOverrides): Promise<void> {
  const chalk = (await import('chalk')).default;

  const results = await Promise.all([
    // 1. Node.js version check
    check('Node.js version >= 20', () => {
      const version = process.version; // e.g. "v20.0.0"
      const major = parseInt(version.slice(1).split('.')[0] ?? '0', 10);
      if (major < 20) {
        throw new Error(`Node.js ${version} detected — upgrade to v20 or later`);
      }
      return Promise.resolve(version);
    }),

    // 2. Config file parse check
    check('Config file is valid', async () => {
      const config = await loadConfig(process.cwd(), options);
      return `Active profile: "${config.defaultProfile}"`;
    }),

    // 3. Provider connectivity
    check('Provider connectivity', async () => {
      const config = await loadConfig(process.cwd(), options);
      const profile = getActiveProfile(config);
      const adapter = await createProvider(profile);
      await adapter.validateCredentials();
      return `Provider: ${profile.provider}`;
    }),

    // 4. ripgrep availability
    check('ripgrep (rg) is available', async () => {
      const { stdout } = await execFileAsync('rg', ['--version'], { timeout: 5000 });
      const firstLine = stdout.split('\n')[0]?.trim() ?? 'rg';
      return firstLine;
    }),

    // 5. Keytar availability
    check('keytar is available (secure credential storage)', async () => {
      try {
        await import('keytar');
        return 'keytar loaded successfully';
      } catch (err) {
        throw new Error(
          `keytar not available — falling back to environment variables. (${
            err instanceof Error ? err.message : String(err)
          })`
        );
      }
    }),
  ]);

  process.stdout.write('\nJam Doctor — system diagnostics\n');
  process.stdout.write(chalk.dim('─'.repeat(60) + '\n\n'));

  for (const result of results) {
    const icon = result.ok ? chalk.green('[✓]') : chalk.red('[✗]');
    const label = result.ok ? chalk.green(result.description) : chalk.red(result.description);
    const detail = result.detail ? chalk.dim(` — ${result.detail}`) : '';
    process.stdout.write(`${icon} ${label}${detail}\n`);
  }

  process.stdout.write('\n');

  const failCount = results.filter((r) => !r.ok).length;
  if (failCount === 0) {
    process.stdout.write(chalk.green('All checks passed.\n'));
  } else {
    process.stdout.write(
      chalk.yellow(`${failCount} check${failCount === 1 ? '' : 's'} failed or degraded.\n`)
    );

    // Additional guidance for known failures
    const rgFailed = results.find(
      (r) => r.description.includes('ripgrep') && !r.ok
    );
    if (rgFailed) {
      process.stdout.write(
        chalk.dim(
          '\nNote: ripgrep is optional — Jam will fall back to a JavaScript-based search.\n' +
            'Install ripgrep for faster search: https://github.com/BurntSushi/ripgrep#installation\n'
        )
      );
    }

    const keytarFailed = results.find(
      (r) => r.description.includes('keytar') && !r.ok
    );
    if (keytarFailed) {
      process.stdout.write(
        chalk.dim(
          '\nNote: Without keytar, API keys must be provided via environment variables.\n' +
            'Example: JAM_API_KEY=<your-key> jam ask "hello"\n'
        )
      );
    }
  }
}
