import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { withRetry, collectStream } from '../utils/stream.js';
import { printError, renderMarkdown } from '../ui/renderer.js';
import { ResponseCache, cachedCollect } from '../storage/response-cache.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import { JiraClient, buildBranchName, formatIssueContext } from '../integrations/jira.js';
import type { CliOverrides } from '../config/schema.js';

const execFileAsync = promisify(execFile);

// ── Helpers ──────────────────────────────────────────────────────────────────

function getJiraClient(config: Awaited<ReturnType<typeof loadConfig>>): JiraClient {
  if (!config.jira) {
    throw new JamError(
      'Jira is not configured. Add a "jira" section to your .jamrc:\n\n' +
      '  {\n' +
      '    "jira": {\n' +
      '      "baseUrl": "https://jira.company.com",\n' +
      '      "email": "you@company.com"\n' +
      '    }\n' +
      '  }\n\n' +
      'Then set your token: export JIRA_API_TOKEN=<your-token>',
      'CONFIG_NOT_FOUND'
    );
  }
  return new JiraClient(config.jira);
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── jam jira issues ──────────────────────────────────────────────────────────

export interface JiraIssuesOptions extends CliOverrides {
  status?: string[];
  json?: boolean;
  quiet?: boolean;
}

export async function runJiraIssues(options: JiraIssuesOptions): Promise<void> {
  try {
    const config = await loadConfig(process.cwd(), options);
    const client = getJiraClient(config);
    const chalk = (await import('chalk')).default;

    const issues = await client.getMyIssues({
      status: options.status,
      jql: config.jira?.defaultJql,
    });

    if (issues.length === 0) {
      process.stdout.write('No issues assigned to you.\n');
      return;
    }

    if (options.json) {
      process.stdout.write(JSON.stringify(issues, null, 2) + '\n');
      return;
    }

    process.stdout.write('\n');
    process.stdout.write(chalk.bold('  Your Jira Issues\n'));
    process.stdout.write(chalk.dim('  ' + '─'.repeat(70) + '\n'));
    process.stdout.write('\n');

    for (let i = 0; i < issues.length; i++) {
      const issue = issues[i]!;
      const num = chalk.dim(`${i + 1}.`);
      const key = chalk.cyan.bold(issue.key.padEnd(12));
      const statusColor =
        issue.status === 'In Progress' ? chalk.yellow :
        issue.status === 'To Do' || issue.status === 'Open' ? chalk.white :
        chalk.dim;
      const status = statusColor(`[${issue.status}]`.padEnd(15));
      const priority = issue.priority === 'High' || issue.priority === 'Highest'
        ? chalk.red(issue.priority)
        : chalk.dim(issue.priority);
      const time = chalk.dim(relativeTime(issue.updated));
      const summary = issue.summary.length > 50
        ? issue.summary.slice(0, 50) + '...'
        : issue.summary;

      process.stdout.write(`  ${num} ${key} ${status} ${summary}\n`);
      process.stdout.write(`     ${chalk.dim(issue.type)} · ${priority} · updated ${time}\n\n`);
    }

    process.stdout.write(chalk.dim(`  ${issues.length} issue${issues.length !== 1 ? 's' : ''}\n`));
    process.stdout.write(chalk.dim('  Use: jam jira start <key> to begin working on an issue\n'));
    process.stdout.write('\n');
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}

// ── jam jira start ───────────────────────────────────────────────────────────

export interface JiraStartOptions extends CliOverrides {
  noBranch?: boolean;
  quiet?: boolean;
}

export async function runJiraStart(issueKey: string | undefined, options: JiraStartOptions): Promise<void> {
  try {
    if (!issueKey) {
      await printError('Provide an issue key. Usage: jam jira start PROJ-123');
      process.exit(1);
    }

    const chalk = (await import('chalk')).default;
    const config = await loadConfig(process.cwd(), options);
    const client = getJiraClient(config);
    const workspaceRoot = await getWorkspaceRoot();
    const write = (msg: string) => process.stderr.write(msg);

    // Fetch full issue details
    write(`Fetching ${issueKey}...\n`);
    const issue = await client.getIssue(issueKey.toUpperCase());

    write('\n');
    write(chalk.bold(`  ${issue.key}: ${issue.summary}\n`));
    write(chalk.dim(`  ${issue.type} · ${issue.priority} · ${issue.status}\n`));
    if (issue.description) {
      const preview = issue.description.length > 200
        ? issue.description.slice(0, 200) + '...'
        : issue.description;
      write(chalk.dim(`  ${preview}\n`));
    }
    write('\n');

    // Create branch (unless --no-branch)
    if (!options.noBranch) {
      const branchName = buildBranchName(issue, config.jira?.branchTemplate);

      // Check if we're already on this branch
      let currentBranch = '';
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspaceRoot });
        currentBranch = stdout.trim();
      } catch { /* not a git repo */ }

      if (currentBranch === branchName) {
        write(chalk.dim(`  Already on branch: ${branchName}\n`));
      } else {
        // Check if branch exists
        let branchExists = false;
        try {
          await execFileAsync('git', ['rev-parse', '--verify', branchName], { cwd: workspaceRoot });
          branchExists = true;
        } catch { /* doesn't exist */ }

        if (branchExists) {
          await execFileAsync('git', ['checkout', branchName], { cwd: workspaceRoot });
          write(`  ${chalk.green('[✓]')} Switched to branch: ${chalk.cyan(branchName)}\n`);
        } else {
          await execFileAsync('git', ['checkout', '-b', branchName], { cwd: workspaceRoot });
          write(`  ${chalk.green('[✓]')} Created branch: ${chalk.cyan(branchName)}\n`);
        }
      }
      write('\n');
    }

    // Generate implementation guidance using AI
    write(chalk.bold('  Generating implementation plan...\n'));
    write('\n');

    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    const issueContext = formatIssueContext(issue);

    const prompt = [
      'You are a senior developer helping a teammate implement a Jira issue.',
      'Based on the issue details below, provide a concise implementation plan:',
      '',
      '1. **Summary** — What needs to be done (1-2 sentences)',
      '2. **Key files** — Which files likely need changes (based on the description and components)',
      '3. **Implementation steps** — Ordered list of concrete steps',
      '4. **Testing** — What to test',
      '5. **Edge cases** — Things to watch out for',
      '',
      'Keep it practical and actionable. No boilerplate.',
      '',
      '---',
      '',
      issueContext,
    ].join('\n');

    const request = {
      messages: [{ role: 'user' as const, content: prompt }],
      model: profile.model,
      temperature: profile.temperature ?? 0.3,
      maxTokens: profile.maxTokens ?? 1024,
      systemPrompt: profile.systemPrompt,
    };

    let text: string;
    if (config.cacheEnabled) {
      const cache = new ResponseCache(config.cacheTtlSeconds * 1000);
      const result = await cachedCollect(cache, profile.provider, request, () =>
        withRetry(() => adapter.streamCompletion(request))
      );
      if (result.fromCache) write('(cached)\n');
      text = result.text;
    } else {
      const result = await collectStream(
        withRetry(() => adapter.streamCompletion(request))
      );
      text = result.text;
    }

    try {
      const rendered = await renderMarkdown(text);
      process.stdout.write(rendered);
    } catch {
      process.stdout.write(text + '\n');
    }

    // Offer to start working with jam run
    write('\n');
    write(chalk.dim('  ' + '─'.repeat(56) + '\n'));
    write('\n');
    write(chalk.dim(`  Ready to implement? Run:\n`));
    write(`  ${chalk.cyan(`jam run "Implement ${issue.key}: ${issue.summary}"`)}\n`);
    write('\n');

  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}

// ── jam jira view ────────────────────────────────────────────────────────────

export interface JiraViewOptions extends CliOverrides {
  json?: boolean;
}

export async function runJiraView(issueKey: string | undefined, options: JiraViewOptions): Promise<void> {
  try {
    if (!issueKey) {
      await printError('Provide an issue key. Usage: jam jira view PROJ-123');
      process.exit(1);
    }

    const config = await loadConfig(process.cwd(), options);
    const client = getJiraClient(config);

    const issue = await client.getIssue(issueKey.toUpperCase());

    if (options.json) {
      process.stdout.write(JSON.stringify(issue, null, 2) + '\n');
      return;
    }

    const context = formatIssueContext(issue);
    try {
      const rendered = await renderMarkdown(context);
      process.stdout.write(rendered);
    } catch {
      process.stdout.write(context + '\n');
    }
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}
