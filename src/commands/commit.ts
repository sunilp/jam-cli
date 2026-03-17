import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider, blockIfEmbedded } from '../providers/factory.js';
import { withRetry, collectStream } from '../utils/stream.js';
import { printError, printSuccess } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import { ResponseCache, cachedCollect } from '../storage/response-cache.js';
import type { CliOverrides, CommitConvention } from '../config/schema.js';

const execFileAsync = promisify(execFile);

export interface CommitOptions extends CliOverrides {
  dry?: boolean;    // generate message but don't commit
  yes?: boolean;    // auto-confirm without prompt
  amend?: boolean;  // amend last commit with new AI message
}

// ── Convention detection from git history ────────────────────────────────────

interface DetectedConvention {
  format: string;
  ticketPattern: string | null;
  types: string[];
  examples: string[];
}

/**
 * Sample recent git commits and detect the commit message convention.
 */
export async function detectConventionFromHistory(cwd: string, sampleSize = 20): Promise<DetectedConvention | null> {
  let logs: string;
  try {
    const { stdout } = await execFileAsync(
      'git', ['log', `--max-count=${sampleSize}`, '--format=%s'],
      { cwd, maxBuffer: 256 * 1024 }
    );
    logs = stdout.trim();
  } catch {
    return null;
  }

  if (!logs) return null;

  const messages = logs.split('\n').filter(Boolean);
  if (messages.length < 3) return null;

  // Detect ticket/issue patterns (JIRA: PROJ-123, GitHub: GH-123, #123)
  const ticketPatterns: Record<string, number> = {};
  const ticketRegexes: Array<{ label: string; regex: RegExp; pattern: string }> = [
    { label: 'jira', regex: /^([A-Z]{2,10}-\d+)/, pattern: '[A-Z]{2,10}-\\d+' },
    { label: 'jira-colon', regex: /^([A-Z]{2,10}-\d+)\s*:/, pattern: '[A-Z]{2,10}-\\d+' },
    { label: 'bracket-ticket', regex: /^\[([A-Z]{2,10}-\d+)\]/, pattern: '[A-Z]{2,10}-\\d+' },
    { label: 'gh-issue', regex: /^#(\d+)/, pattern: '#\\d+' },
  ];

  for (const msg of messages) {
    for (const { label, regex } of ticketRegexes) {
      if (regex.test(msg)) {
        ticketPatterns[label] = (ticketPatterns[label] ?? 0) + 1;
      }
    }
  }

  // Detect conventional commit types
  const conventionalRegex = /^(feat|fix|docs|style|refactor|perf|test|chore|ci|build)(\([^)]+\))?[!]?:\s/;
  let conventionalCount = 0;
  const types = new Set<string>();

  for (const msg of messages) {
    const match = msg.match(conventionalRegex);
    if (match) {
      conventionalCount++;
      types.add(match[1]!);
    }
  }

  // Determine dominant pattern
  const dominantTicket = Object.entries(ticketPatterns)
    .sort((a, b) => b[1] - a[1])
    .find(([, count]) => count >= messages.length * 0.3);

  const isConventional = conventionalCount >= messages.length * 0.3;

  // Build the detected format
  let format: string;
  let ticketPattern: string | null = null;

  if (dominantTicket && isConventional) {
    const ticketDef = ticketRegexes.find((t) => t.label === dominantTicket[0])!;
    ticketPattern = ticketDef.pattern;
    if (dominantTicket[0] === 'bracket-ticket') {
      format = '[{ticket}] {type}({scope}): {description}';
    } else if (dominantTicket[0] === 'jira-colon') {
      format = '{ticket}: {type}({scope}): {description}';
    } else {
      format = '{ticket} {type}({scope}): {description}';
    }
  } else if (dominantTicket) {
    const ticketDef = ticketRegexes.find((t) => t.label === dominantTicket[0])!;
    ticketPattern = ticketDef.pattern;
    if (dominantTicket[0] === 'bracket-ticket') {
      format = '[{ticket}] {description}';
    } else {
      format = '{ticket}: {description}';
    }
  } else if (isConventional) {
    format = '{type}({scope}): {description}';
  } else {
    return null; // No clear convention detected
  }

  // Pick representative examples (up to 5)
  const examples = messages.slice(0, 5);

  return {
    format,
    ticketPattern,
    types: [...types],
    examples,
  };
}

// ── System prompt builder ───────────────────────────────────────────────────

const BASE_RULES = [
  'Short description: imperative mood, lowercase, no period, ≤72 chars total for the first line',
  'If changes are complex, add a blank line followed by a brief body (max 3 lines)',
  'Output ONLY the commit message text, nothing else — no markdown, no explanation',
];

/**
 * Build a commit system prompt that adapts to the project's convention.
 */
export function buildCommitSystemPrompt(
  convention: CommitConvention | undefined,
  detected: DetectedConvention | null,
  isSmallModel: boolean,
): string {
  if (isSmallModel) {
    // Compact for small models
    const format = convention?.format ?? detected?.format ?? 'type(scope): short description';
    return [
      `Generate a commit message for the code changes described.`,
      `Output ONLY the commit message, nothing else — no explanation, no prefix, no markdown.`,
      `Format: ${format}`,
      ...(convention?.types?.length ? [`Types: ${convention.types.join(', ')}`] : []),
      ...(convention?.ticketRequired ? [`Include a ticket ID matching: ${convention.ticketPattern ?? detected?.ticketPattern ?? 'PROJ-123'}`] : []),
      `Rules: imperative mood, lowercase, no period, under 72 characters.`,
    ].join('\n');
  }

  const format = convention?.format ?? detected?.format;
  const types = convention?.types ?? detected?.types ?? [];
  const ticketPat = convention?.ticketPattern ?? detected?.ticketPattern;
  const customRules = convention?.rules ?? [];
  const examples = detected?.examples ?? [];

  const sections: string[] = [
    'You are an expert software engineer. Given a git diff, generate a concise commit message.',
    '',
  ];

  // Format
  if (format) {
    sections.push(`Format: ${format}`);
    sections.push('Placeholders: {type} = commit type, {scope} = affected area, {description} = what changed, {ticket} = issue/ticket ID');
  } else {
    sections.push('Format: <type>(<scope>): <short description>');
  }

  // Types
  if (types.length > 0) {
    sections.push(`Allowed types: ${types.join(', ')}`);
  } else {
    sections.push('Types: feat, fix, docs, style, refactor, perf, test, chore, ci, build');
  }

  // Ticket
  if (convention?.ticketRequired) {
    sections.push(`Ticket is REQUIRED. Pattern: ${ticketPat ?? 'PROJ-\\d+'}`);
    sections.push('If you cannot determine the ticket ID from context, use a placeholder like PROJ-XXX');
  } else if (ticketPat) {
    sections.push(`Ticket pattern (if applicable): ${ticketPat}`);
  }

  sections.push('');

  // Rules
  sections.push('Rules:');
  for (const rule of BASE_RULES) {
    sections.push(`- ${rule}`);
  }
  for (const rule of customRules) {
    sections.push(`- ${rule}`);
  }

  // Examples from history
  if (examples.length > 0) {
    sections.push('');
    sections.push('Recent commit messages from this project (follow this style):');
    for (const ex of examples.slice(0, 5)) {
      sections.push(`  "${ex}"`);
    }
  }

  return sections.join('\n');
}

// ── Legacy prompts (fallback) ───────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert software engineer. Given a git diff, generate a concise \
commit message following the Conventional Commits specification.

Rules:
- Format: <type>(<scope>): <short description>
- Types: feat, fix, docs, style, refactor, perf, test, chore, ci, build
- Scope is optional but helpful when it adds clarity
- Short description: imperative mood, lowercase, no period, ≤72 chars total for the first line
- If changes are complex, add a blank line followed by a brief body (max 3 lines)
- Output ONLY the commit message text, nothing else — no markdown, no explanation`;

/**
 * Compact system prompt for small/embedded models that struggle with
 * long instructions. No example — examples cause small models to echo them.
 */
const SYSTEM_PROMPT_SMALL = `Generate a conventional commit message for the code changes described.
Output ONLY the commit message, nothing else — no explanation, no prefix, no markdown.
Format: type(scope): short description
Types: feat, fix, docs, style, refactor, perf, test, chore
Rules: imperative mood, lowercase, no period, under 72 characters.`;

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

export async function getStagedDiffStat(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--staged', '--stat'], {
      cwd,
      maxBuffer: 256 * 1024,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Build a commit prompt that fits within the provider's context window.
 *
 * For full-context providers: send the complete diff as-is.
 * For small-context providers (e.g. embedded): send only the --stat summary
 * (files changed + line counts) without any raw diff syntax, which prevents
 * the model from echoing diff content instead of generating a commit message.
 * If even the stat is too large, truncate it at a line boundary.
 */
export function buildCommitPrompt(
  diff: string,
  stat: string,
  contextWindow: number,
  systemPromptLen: number,
  outputBudget: number,
): string {
  const safetyMargin = Math.ceil(contextWindow * 0.1);
  const inputBudgetChars = Math.max(400, (contextWindow - outputBudget - Math.ceil(systemPromptLen / 4) - safetyMargin) * 4);

  const header = 'Generate a conventional commit message for the following changes:\n\n';
  const fullDiffPrompt = header + '```diff\n' + diff + '\n```';

  // Full diff fits — use it as-is
  if (fullDiffPrompt.length <= inputBudgetChars) {
    return fullDiffPrompt;
  }

  // Diff too large: describe the changes in plain English from the stat.
  // No code fences, no diff syntax — avoids the model echoing raw diff lines.
  const statlessHeader = 'Write a conventional commit message for a code change that modified the following files:\n\n';
  const statLines = stat.split('\n').filter((l) => l.trim() && !l.includes('changed,'));
  const fileList = statLines
    .map((l) => {
      const m = l.match(/^\s*(\S+)\s*\|\s*(\d+)\s*([+-]+)/);
      return m ? `${m[1]} (${m[2]} lines changed)` : l.trim();
    })
    .filter(Boolean)
    .join(', ');

  const summaryLine = fileList
    ? `These files were modified: ${fileList}.`
    : stat;

  const budgetForBody = inputBudgetChars - statlessHeader.length;
  const body = summaryLine.length <= budgetForBody
    ? summaryLine
    : summaryLine.slice(0, budgetForBody - 3) + '...';

  return statlessHeader + body;
}

/** Strip surrounding whitespace and any accidental markdown fences from the model output.
 * Also strips common small-model preamble like "Based on the diff, the commit message is:".
 */
export function cleanCommitMessage(raw: string): string {
  // Remove optional triple-backtick wrappers the model might produce
  let stripped = raw.replace(/^```[^\n]*\n?/m, '').replace(/\n?```\s*$/m, '');
  // Strip common small-model preamble — lines ending in ":" that precede the actual message
  stripped = stripped.replace(
    /^[^\n]{0,120}(?:commit message|message|type|format|output|follows?|below|is)[:\s]*\n+/im,
    ''
  );
  // Try to extract a well-formed commit line from model output
  const lines = stripped.trim().split('\n');

  // Match conventional commits: type(scope): description
  const conventionalLine = lines.find((l) =>
    /^(feat|fix|docs|style|refactor|perf|test|chore|ci|build)(\([^)]+\))?[!]?:\s+\S/.test(l.trim())
  );
  if (conventionalLine) {
    const idx = lines.indexOf(conventionalLine);
    return lines.slice(idx).join('\n').trim();
  }

  // Match ticket-prefixed: PROJ-123: description or [PROJ-123] description
  const ticketLine = lines.find((l) =>
    /^(\[?[A-Z]{2,10}-\d+\]?)\s*[:\s]/.test(l.trim())
  );
  if (ticketLine) {
    const idx = lines.indexOf(ticketLine);
    return lines.slice(idx).join('\n').trim();
  }

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
    blockIfEmbedded(adapter, 'commit');

    // Build a context-aware diff prompt — falls back to stat-only summary
    // if the diff would overflow the provider's context window.
    const contextWindow = adapter.info?.contextWindow;
    const isSmallModel = Boolean(contextWindow);
    const stat = isSmallModel ? await getStagedDiffStat(workspaceRoot) : '';

    // Detect commit convention from git history + config
    const configConvention = config.commitConvention;
    const shouldAutoDetect = configConvention?.autoDetect !== false;
    let detected: DetectedConvention | null = null;
    if (shouldAutoDetect) {
      detected = await detectConventionFromHistory(workspaceRoot);
      if (detected) {
        process.stderr.write(`Detected convention: ${detected.format}\n`);
      }
    }

    const hasConvention = configConvention?.format || detected;
    const activeSystemPrompt = hasConvention
      ? buildCommitSystemPrompt(configConvention, detected, isSmallModel)
      : isSmallModel ? SYSTEM_PROMPT_SMALL : SYSTEM_PROMPT;

    const prompt = contextWindow
      ? buildCommitPrompt(diff, stat, contextWindow, activeSystemPrompt.length, 256)
      : `Generate a conventional commit message for the following git diff:\n\n\`\`\`diff\n${diff}\n\`\`\``;

    process.stderr.write('Generating commit message...\n');

    const request = {
      messages: [{ role: 'user' as const, content: prompt }],
      model: profile.model,
      temperature: profile.temperature ?? 0.2,
      maxTokens: 256,
      systemPrompt: isSmallModel ? activeSystemPrompt : SYSTEM_PROMPT,
    };

    let text: string;
    if (config.cacheEnabled) {
      const cache = new ResponseCache(config.cacheTtlSeconds * 1000);
      const result = await cachedCollect(cache, profile.provider, request, () =>
        withRetry(() => adapter.streamCompletion(request))
      );
      if (result.fromCache) process.stderr.write('(cached)\n');
      text = result.text;
    } else {
      const result = await collectStream(
        withRetry(() => adapter.streamCompletion(request))
      );
      text = result.text;
    }

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
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}
