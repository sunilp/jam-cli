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

export interface ReviewOptions extends CliOverrides {
  base?: string;    // base branch/ref to diff against (default: main)
  pr?: number;      // PR number to review (requires GitHub CLI)
  json?: boolean;
}

// ── Git helpers ────────────────────────────────────────────────────────────────

/**
 * Returns the diff between the current branch and the given base ref.
 * Uses `git diff <base>...HEAD` (three-dot) to show only changes introduced
 * on the current branch since it diverged from base.
 */
export async function getBranchDiff(cwd: string, base: string): Promise<string> {
  const mergeBase = await getMergeBase(cwd, base);
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', mergeBase, 'HEAD'],
      { cwd, maxBuffer: 4 * 1024 * 1024 }
    );
    return stdout.trim();
  } catch (err) {
    throw new JamError(
      `Failed to compute diff against "${base}". Is this a git repository with commits?`,
      'TOOL_EXEC_ERROR',
      { cause: err }
    );
  }
}

export async function getMergeBase(cwd: string, base: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['merge-base', base, 'HEAD'],
      { cwd }
    );
    return stdout.trim();
  } catch (err) {
    throw new JamError(
      `Could not find merge-base with "${base}". Does the base branch exist?`,
      'TOOL_EXEC_ERROR',
      { cause: err }
    );
  }
}

/**
 * Returns the diff for a specific PR number using the GitHub CLI (`gh`).
 * Requires `gh` to be installed and authenticated.
 */
export async function getPrDiff(cwd: string, pr: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'diff', String(pr)],
      { cwd, maxBuffer: 4 * 1024 * 1024 }
    );
    return stdout.trim();
  } catch (err) {
    throw new JamError(
      `Failed to fetch diff for PR #${pr}. Make sure the GitHub CLI (gh) is installed and authenticated.`,
      'TOOL_EXEC_ERROR',
      { cause: err }
    );
  }
}

/**
 * Returns the current branch name.
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd }
    );
    return stdout.trim();
  } catch (err) {
    throw new JamError(
      'Failed to determine the current branch.',
      'TOOL_EXEC_ERROR',
      { cause: err }
    );
  }
}

// ── Prompt builder ─────────────────────────────────────────────────────────────

export function buildReviewPrompt(diff: string, context: string): string {
  return (
    `${context}\n\n` +
    `Please provide a thorough code review covering:\n` +
    `1. **Summary** — a concise overview of what changed\n` +
    `2. **Potential Issues** — bugs, edge cases, security concerns, or performance problems\n` +
    `3. **Suggestions** — improvements to readability, maintainability, or correctness\n\n` +
    `\`\`\`diff\n${diff}\n\`\`\``
  );
}

// ── Main command ───────────────────────────────────────────────────────────────

export async function runReview(options: ReviewOptions = {}): Promise<void> {
  try {
    const workspaceRoot = await getWorkspaceRoot();
    const base = options.base ?? 'main';

    let diff: string;
    let context: string;

    if (options.pr !== undefined) {
      diff = await getPrDiff(workspaceRoot, options.pr);
      context = `Reviewing PR #${options.pr}.`;
    } else {
      const branch = await getCurrentBranch(workspaceRoot);
      diff = await getBranchDiff(workspaceRoot, base);
      context =
        branch === base
          ? `Reviewing unstaged/uncommitted changes on "${base}".`
          : `Reviewing changes on branch "${branch}" compared to "${base}".`;
    }

    if (!diff) {
      process.stdout.write('No differences found. Nothing to review.\n');
      return;
    }

    const config = await loadConfig(process.cwd(), options);
    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    const prompt = buildReviewPrompt(diff, context);

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
