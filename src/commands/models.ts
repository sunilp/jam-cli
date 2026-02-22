import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { JamError } from '../utils/errors.js';
import type { CliOverrides } from '../config/schema.js';

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
