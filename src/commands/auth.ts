import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { printError, printSuccess, printWarning } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import type { CliOverrides } from '../config/schema.js';

export async function runAuthLogin(options: CliOverrides = {}): Promise<void> {
  try {
    const config = await loadConfig(process.cwd(), options);
    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    process.stderr.write(`Validating credentials for provider: ${adapter.info.name}\n`);

    await adapter.validateCredentials();

    await printSuccess(`✓ Connected to ${adapter.info.name} at ${profile.baseUrl ?? 'default'}`);
    await printSuccess(`  Model: ${profile.model ?? 'default'}`);
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message);

    if (jamErr.code === 'PROVIDER_UNAVAILABLE') {
      await printWarning('Make sure Ollama is running: ollama serve');
    }

    process.exit(1);
  }
}

export async function runAuthLogout(options: CliOverrides = {}): Promise<void> {
  try {
    const config = await loadConfig(process.cwd(), options);
    const profile = getActiveProfile(config);

    const { deleteSecret } = await import('../utils/secrets.js');
    const key = `${profile.provider}-api-key`;
    const deleted = await deleteSecret(key);

    if (deleted) {
      await printSuccess(`Removed stored credentials for ${profile.provider}`);
    } else {
      process.stderr.write(`No stored credentials found for ${profile.provider}\n`);
    }
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message);
    process.exit(1);
  }
}
