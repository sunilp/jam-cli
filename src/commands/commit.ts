import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { withRetry, collectStream } from '../utils/stream.js';
import { printError, printSuccess } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import type { CliOverrides } from '../config/schema.js';

const execFileAsync = promisify(execFile);

export interface CommitOptions extends CliOverrides {
  dry?: boolean;    // generate message but don't commit
  yes?: boolean;    // auto-confirm without prompt
  amend?: boolean;  // amend last commit with new AI message
}

// ── Conventional-commit system prompt ────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert software engineer. Given a git diff, generate a concise \
commit message following the Conventional Commits specification.

Rules:
- Format: <type>(<scope>): <short description>
- Types: feat, fix, docs, style, refactor, perf, test, chore, ci, build
- Scope is optional but helpful when it adds clarity
- Short description: imperative mood, lowercase, no period, ≤72 chars total for the first line
- If changes are complex, add a blank line followed by a brief body (max 3 lines)
- Output ONLY the commit message text, nothing else — no markdown, no explanation`;

// ── Git helpers ───────────────────────────────────────────────────────────────

export async function getStagedDiff(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--staged'], {
      cwd,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    throw new JamError(
      'Failed to run git diff --staged. Is this a git repository?',
      'TOOL_EXEC_ERROR',
      { cause: err }
    );
  }
}

export async function getLastCommitDiff(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['show', 'HEAD'], {
      cwd,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    throw new JamError(
      'Failed to get the last commit diff. Is there at least one commit in this repository?',
      'TOOL_EXEC_ERROR',
      { cause: err }
    );
  }
}

async function runGitCommit(message: string, amend: boolean, cwd: string): Promise<void> {
  const args = ['commit', '-m', message];
  if (amend) args.push('--amend');
  try {
    await execFileAsync('git', args, { cwd });
  } catch (err) {
    throw new JamError(
      'git commit failed. Make sure you have staged changes and a valid git identity.',
      'TOOL_EXEC_ERROR',
      { cause: err }
    );
  }
}

// ── Pure helpers (exported for testing) ──────────────────────────────────────

/** Strip surrounding whitespace and any accidental markdown fences from the model output. */
export function cleanCommitMessage(raw: string): string {
  // Remove optional triple-backtick wrappers the model might produce
  const stripped = raw.replace(/^```[^\n]*\n?/m, '').replace(/\n?```\s*$/m, '');
  return stripped.trim();
}

// ── Main command ──────────────────────────────────────────────────────────────

export async function runCommit(options: CommitOptions): Promise<void> {
  try {
    const workspaceRoot = await getWorkspaceRoot();

    // Determine which diff to use
    let diff: string;
    if (options.amend) {
      // For amend: prefer staged changes merged on top of the last commit, else just the last commit
      const staged = await getStagedDiff(workspaceRoot);
      const last = await getLastCommitDiff(workspaceRoot);
      diff = staged || last;
      if (!diff) {
        await printError('No staged changes or previous commit diff found for --amend.');
        process.exit(1);
      }
    } else {
      diff = await getStagedDiff(workspaceRoot);
      if (!diff) {
        await printError(
          'No staged changes found. Stage your changes with `git add` first.'
        );
        process.exit(1);
      }
    }

    // Load config and create provider
    const config = await loadConfig(process.cwd(), options);
    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    const prompt =
      `Generate a conventional commit message for the following git diff:\n\n` +
      `\`\`\`diff\n${diff}\n\`\`\``;

    process.stderr.write('Generating commit message...\n');

    const { text } = await collectStream(
      withRetry(() =>
        adapter.streamCompletion({
          messages: [{ role: 'user', content: prompt }],
          model: profile.model,
          temperature: profile.temperature ?? 0.2,
          maxTokens: 256,
          systemPrompt: SYSTEM_PROMPT,
        })
      )
    );

    const message = cleanCommitMessage(text);

    if (!message) {
      await printError('The model did not produce a commit message. Please try again.');
      process.exit(1);
    }

    // Display the generated message
    process.stdout.write('\nGenerated commit message:\n\n');
    process.stdout.write('  ' + message.split('\n').join('\n  ') + '\n\n');

    if (options.dry) {
      process.stderr.write('Dry run — no commit was made.\n');
      return;
    }

    // Confirm (unless --yes)
    if (!options.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = await rl.question(
        options.amend
          ? 'Amend last commit with this message? [y/N] '
          : 'Commit with this message? [y/N] '
      );
      rl.close();
      if (answer.toLowerCase() !== 'y') {
        process.stderr.write('Commit cancelled.\n');
        return;
      }
    }

    await runGitCommit(message, options.amend ?? false, workspaceRoot);
    await printSuccess(
      options.amend ? 'Last commit amended successfully.' : 'Commit created successfully.'
    );
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message);
    process.exit(1);
  }
}
