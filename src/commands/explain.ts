import { readFile, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { withRetry } from '../utils/stream.js';
import { streamToStdout, printJsonResult, printError } from '../ui/renderer.js';
import { collectStream } from '../utils/stream.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import type { CliOverrides } from '../config/schema.js';

const MAX_FILE_BYTES = 500_000;

export interface ExplainOptions extends CliOverrides {
  json?: boolean;
  noColor?: boolean;
}

function addLineNumbers(content: string): string {
  return content
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`)
    .join('\n');
}

export async function runExplain(filePaths: string[], options: ExplainOptions): Promise<void> {
  if (filePaths.length === 0) {
    await printError('Provide at least one file path. Usage: jam explain <path> [<path2> ...]');
    process.exit(1);
  }

  try {
    const workspaceRoot = await getWorkspaceRoot();
    const config = await loadConfig(process.cwd(), options);
    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    const sections: string[] = [];

    for (const filePath of filePaths) {
      const absPath = resolve(filePath);
      const relPath = relative(workspaceRoot, absPath);

      let content: string;
      try {
        const stats = await stat(absPath);
        if (stats.size > MAX_FILE_BYTES) {
          const raw = await readFile(absPath);
          content = raw.subarray(0, MAX_FILE_BYTES).toString('utf-8');
          sections.push(
            `# File: ${relPath} (truncated to first ${MAX_FILE_BYTES / 1000}KB)\n\`\`\`\n${addLineNumbers(content)}\n\`\`\``
          );
        } else {
          content = await readFile(absPath, 'utf-8');
          sections.push(`# File: ${relPath}\n\`\`\`\n${addLineNumbers(content)}\n\`\`\``);
        }
      } catch (err) {
        throw new JamError(`Cannot read file: ${filePath}`, 'INPUT_FILE_NOT_FOUND', { cause: err });
      }
    }

    const prompt =
      `Please explain the following file${filePaths.length > 1 ? 's' : ''} in detail:\n\n` +
      sections.join('\n\n') +
      '\n\nFocus on: purpose, key logic, important patterns, and anything a new developer should know.';

    const request = {
      messages: [{ role: 'user' as const, content: prompt }],
      model: profile.model,
      temperature: profile.temperature,
      maxTokens: profile.maxTokens,
      systemPrompt: profile.systemPrompt,
    };

    if (options.json) {
      const { text, usage } = await collectStream(
        withRetry(() => adapter.streamCompletion(request))
      );
      printJsonResult({ response: text, usage, model: profile.model });
    } else {
      await streamToStdout(withRetry(() => adapter.streamCompletion(request)));
    }
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message);
    process.exit(1);
  }
}
