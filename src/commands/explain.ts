import { readFile, stat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { withRetry } from '../utils/stream.js';
import { streamToStdout, printJsonResult, printError } from '../ui/renderer.js';
import { collectStream } from '../utils/stream.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import { getVscodeContext } from '../utils/vscode-context.js';
import type { VscodeContext } from '../utils/vscode-context.js';
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
  // Handle "jam explain" or "jam explain this" with no real file path —
  // try to get the active file/selection from VSCode extension
  const isVscodeShorthand =
    filePaths.length === 0 ||
    (filePaths.length === 1 && filePaths[0]!.toLowerCase() === 'this');

  if (isVscodeShorthand) {
    const ctx = await getVscodeContext();

    if (ctx?.selection) {
      // User has text selected — explain the selection
      return runExplainSelection(ctx, options);
    }

    if (ctx?.file) {
      // No selection but a file is open — explain that file
      filePaths = [ctx.file];
    } else if (filePaths.length === 0 || filePaths[0]!.toLowerCase() === 'this') {
      await printError(
        'No file specified.\n' +
        '  In VSCode terminal: open a file and run `jam explain` or `jam explain this`\n' +
        '  Otherwise: jam explain <path>'
      );
      process.exit(1);
    }
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
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}

/**
 * Explain selected text from the VSCode editor.
 */
async function runExplainSelection(
  ctx: VscodeContext,
  options: ExplainOptions
): Promise<void> {
  try {
    const config = await loadConfig(process.cwd(), options);
    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    const fileName = ctx.file ? relative(process.cwd(), ctx.file) : 'unknown';
    const range = ctx.selectionRange
      ? ` (lines ${ctx.selectionRange.startLine}-${ctx.selectionRange.endLine})`
      : '';

    const prompt =
      `Please explain this code from ${fileName}${range}:\n\n` +
      `\`\`\`\n${ctx.selection}\n\`\`\`\n\n` +
      'Focus on: what it does, why, and anything non-obvious.';

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
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}
