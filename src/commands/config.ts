import { loadConfig, getActiveProfile } from '../config/loader.js';
import { printError, printSuccess } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import type { CliOverrides } from '../config/schema.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { CONFIG_DEFAULTS } from '../config/defaults.js';

export async function runConfigShow(options: CliOverrides = {}): Promise<void> {
  try {
    const config = await loadConfig(process.cwd(), options);
    const profile = getActiveProfile(config);

    const output = {
      config,
      activeProfile: {
        name: config.defaultProfile,
        ...profile,
      },
    };

    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message);
    process.exit(1);
  }
}

export async function runConfigInit(options: { global?: boolean } = {}): Promise<void> {
  try {
    let configDir: string;
    let configPath: string;

    if (options.global) {
      // Use ~/.jam/config.json as the preferred user-level location
      configDir = join(homedir(), '.jam');
      configPath = join(configDir, 'config.json');
    } else {
      configDir = join(process.cwd(), '.jam');
      configPath = join(configDir, 'config.json');
    }

    await mkdir(configDir, { recursive: true });

    const initialConfig = {
      defaultProfile: 'default',
      profiles: {
        default: {
          provider: CONFIG_DEFAULTS.profiles['default']?.provider ?? 'ollama',
          model: CONFIG_DEFAULTS.profiles['default']?.model ?? 'llama3.2',
          baseUrl: CONFIG_DEFAULTS.profiles['default']?.baseUrl ?? 'http://localhost:11434',
        },
      },
    };

    await writeFile(configPath, JSON.stringify(initialConfig, null, 2) + '\n');
    await printSuccess(`Config initialized at: ${configPath}`);
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message);
    process.exit(1);
  }
}
