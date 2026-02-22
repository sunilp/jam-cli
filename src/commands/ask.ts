import { readFile } from 'node:fs/promises';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { withRetry, collectStream } from '../utils/stream.js';
import { streamToStdout, printJsonResult, printError } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import type { CliOverrides } from '../config/schema.js';

export interface AskOptions extends CliOverrides {
  file?: string;
  json?: boolean;
  noColor?: boolean;
  system?: string;
}

async function readPromptFromStdin(): Promise<string | null> {
  // Only read from stdin if it's piped (not interactive TTY)
  if (process.stdin.isTTY) return null;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8').trim()));
    process.stdin.on('error', reject);
  });
}

export async function runAsk(inlinePrompt: string | undefined, options: AskOptions): Promise<void> {
  try {
    // Resolve prompt from file, inline arg, or stdin (priority order)
    let prompt: string;

    if (options.file) {
      try {
        prompt = (await readFile(options.file, 'utf-8')).trim();
      } catch (err) {
        throw new JamError(
          `Cannot read file: ${options.file}`,
          'INPUT_FILE_NOT_FOUND',
          { cause: err }
        );
      }
    } else if (inlinePrompt) {
      prompt = inlinePrompt;
    } else {
      const stdinContent = await readPromptFromStdin();
      if (!stdinContent) {
        throw new JamError(
          'No prompt provided. Pass a question as an argument, pipe from stdin, or use --file.',
          'INPUT_MISSING'
        );
      }
      prompt = stdinContent;
    }

    if (options.noColor) {
      const chalk = await import('chalk');
      chalk.default.level = 0;
    }

    // Load config with CLI overrides
    const cliOverrides: CliOverrides = {
      profile: options.profile,
      provider: options.provider,
      model: options.model,
      baseUrl: options.baseUrl,
    };
    const config = await loadConfig(process.cwd(), cliOverrides);
    const profile = getActiveProfile(config);

    // Create provider
    const adapter = await createProvider(profile);

    const request = {
      messages: [{ role: 'user' as const, content: prompt }],
      model: profile.model,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      systemPrompt: options.system ?? profile.systemPrompt,
    };

    if (options.json) {
      // Collect stream then emit JSON
      const stream = withRetry(() => adapter.streamCompletion(request));
      const { text, usage } = await collectStream(stream);
      printJsonResult({
        response: text,
        usage,
        model: profile.model,
      });
    } else {
      // Stream directly to stdout
      const stream = withRetry(() => adapter.streamCompletion(request));
      await streamToStdout(stream);
    }
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message);
    process.exit(1);
  }
}
