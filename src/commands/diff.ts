import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { withRetry, collectStream } from '../utils/stream.js';
import { streamToStdout, printJsonResult, printError } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import type { CliOverrides } from '../config/schema.js';

const execFileAsync = promisify(execFile);

export interface DiffOptions extends CliOverrides {
  staged?: boolean;
  path?: string;
  json?: boolean;
  noReview?: boolean;   // just show diff, don't send to AI
}

async function getGitDiff(cwd: string, staged: boolean, path?: string): Promise<string> {
  const args = ['diff'];
  if (staged) args.push('--staged');
  if (path) args.push('--', path);

  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 2 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    throw new JamError(
      'Failed to run git diff. Is this a git repository?',
      'TOOL_EXEC_ERROR',
      { cause: err }
    );
  }
}

export async function runDiff(options: DiffOptions): Promise<void> {
  try {
    const workspaceRoot = await getWorkspaceRoot();
    const diff = await getGitDiff(workspaceRoot, options.staged ?? false, options.path);

    if (!diff) {
      const target = options.staged ? 'staged changes' : 'working tree changes';
      process.stdout.write(`No ${target} found.\n`);
      return;
    }

    if (options.noReview) {
      process.stdout.write(diff + '\n');
      return;
    }

    const config = await loadConfig(process.cwd(), options);
    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    const context = options.staged
      ? 'These are the staged changes (ready to commit).'
      : 'These are the current working tree changes (unstaged).';

    const prompt =
      `${context} Please review this git diff and provide:\n` +
      `1. A summary of what changed\n` +
      `2. Potential issues, risks, or improvements\n` +
      `3. A suggested commit message (if staged)\n\n` +
      `\`\`\`diff\n${diff}\n\`\`\``;

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
