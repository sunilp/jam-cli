import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { JamError } from '../utils/errors.js';
import type { CliOverrides } from '../config/schema.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export async function runModelsSet(model: string, options: CliOverrides): Promise<void> {
  try {
    // Validate: list available models and check if the requested one exists
    const config = await loadConfig(process.cwd(), options);
    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    let available: string[];
    try {
      available = await adapter.listModels();
    } catch {
      available = [];
    }

    if (available.length > 0 && !available.includes(model)) {
      process.stderr.write(`Warning: "${model}" not found in available models for ${profile.provider}.\n`);
      process.stderr.write(`Available: ${available.join(', ')}\n\n`);
      process.stderr.write(`Setting it anyway — it may work if the provider accepts it.\n\n`);
    }

    // Read or create ~/.jam/config.json
    const configDir = join(homedir(), '.jam');
    const configPath = join(configDir, 'config.json');

    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>;
    } catch { /* file doesn't exist yet */ }

    // Merge the model into the active profile
    const profileName = (existing['defaultProfile'] as string) ?? 'default';
    const profiles = (existing['profiles'] ?? {}) as Record<string, Record<string, unknown>>;
    const activeProfile = profiles[profileName] ?? {};

    profiles[profileName] = { ...activeProfile, model };
    existing['profiles'] = profiles;

    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(existing, null, 2) + '\n');

    process.stdout.write(`Model set to "${model}" for profile "${profileName}".\n`);
    process.stdout.write(`Config: ${configPath}\n`);
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    process.stderr.write(`Error: ${jamErr.message}\n`);
    process.exit(1);
  }
}

export async function runModelsList(options: CliOverrides): Promise<void> {
  try {
    const config = await loadConfig(process.cwd(), options);
    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    let models: string[];
    try {
      models = await adapter.listModels();
    } catch (err) {
      if (JamError.isJamError(err) && err.code === 'PROVIDER_UNAVAILABLE') {
        process.stderr.write(
          `Cannot reach provider "${profile.provider}". ` +
            `Make sure it is running and reachable.\n\n` +
            `Details: ${err.message}\n`
        );
        process.exit(1);
      }
      throw err;
    }

    if (models.length === 0) {
      process.stdout.write(
        `No models found for provider "${profile.provider}".\n\n` +
          `Try pulling a model first. For Ollama: ollama pull llama3.2\n`
      );
      return;
    }

    process.stdout.write(`Available models (${profile.provider}):\n\n`);
    for (const model of models) {
      process.stdout.write(`  ${model}\n`);
    }
    process.stdout.write('\n');
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    process.stderr.write(`Error: ${jamErr.message}\n`);
    process.exit(1);
  }
}
