#!/usr/bin/env node
import { program } from 'commander';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { LOGO_PLAIN, printLogo } from './ui/logo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as {
  version: string;
};

// ── Global options ────────────────────────────────────────────────────────────
program
  .name('jam')
  .description('Jam — developer-first AI assistant CLI')
  .version(pkg.version)
  .addHelpText('before', `\n${LOGO_PLAIN}\n`)
  .option('--profile <name>', 'use a specific config profile')
  .option('--provider <name>', 'override the AI provider')
  .option('--model <name>', 'override the model')
  .option('--base-url <url>', 'override the provider base URL')
  .option('--no-color', 'disable color output')
  .option('--verbose', 'enable debug logging')
  .option('-q, --quiet', 'suppress non-essential output (spinners, status lines, decorations)');

// ── Helpers ───────────────────────────────────────────────────────────────────
function globalOpts() {
  return program.opts<{
    profile?: string;
    provider?: string;
    model?: string;
    baseUrl?: string;
    color?: boolean;
    verbose?: boolean;
    quiet?: boolean;
  }>();
}

// ── ask ───────────────────────────────────────────────────────────────────────
program
  .command('ask [prompt]')
  .description('Send a one-shot question to the AI')
  .option('--file <path>', 'read prompt from file')
  .option('--json', 'output response as JSON')
  .option('--system <prompt>', 'override the system prompt')
  .option('--no-tools', 'disable read-only tool use (file discovery off)')
  .action(async (prompt: string | undefined, cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runAsk } = await import('./commands/ask.js');
    await runAsk(prompt, {
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      noColor: g.color === false,
      quiet: g.quiet,
      file: cmdOpts['file'] as string | undefined,
      json: cmdOpts['json'] as boolean | undefined,
      system: cmdOpts['system'] as string | undefined,
      tools: cmdOpts['tools'] as boolean | undefined,
    });
  });

// ── chat ──────────────────────────────────────────────────────────────────────
program
  .command('chat')
  .description('Start an interactive multi-turn chat session')
  .option('--resume <sessionId>', 'resume a previous session')
  .option('--name <name>', 'name for the new session')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runChat } = await import('./commands/chat.js');
    await runChat({
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      resume: cmdOpts['resume'] as string | undefined,
      name: cmdOpts['name'] as string | undefined,
    });
  });

// ── run ───────────────────────────────────────────────────────────────────────
program
  .command('run [instruction]')
  .description('Execute a task workflow using AI and local tools')
  .action(async (instruction: string | undefined) => {
    const g = globalOpts();
    const { runRun } = await import('./commands/run.js');
    await runRun(instruction, {
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      noColor: g.color === false,
    });
  });

// ── explain ───────────────────────────────────────────────────────────────────
program
  .command('explain <path...>')
  .description('Explain the contents of one or more files')
  .option('--json', 'output response as JSON')
  .action(async (paths: string[], cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runExplain } = await import('./commands/explain.js');
    await runExplain(paths, {
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      noColor: g.color === false,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── search ────────────────────────────────────────────────────────────────────
program
  .command('search [query]')
  .description('Search the codebase for text or patterns')
  .option('--glob <pattern>', 'limit search to files matching glob')
  .option('--max-results <n>', 'maximum number of results', '20')
  .option('--ask', 'pipe results to AI for explanation')
  .option('--json', 'output as JSON (with --ask)')
  .action(async (query: string | undefined, cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runSearch } = await import('./commands/search.js');
    await runSearch(query, {
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      glob: cmdOpts['glob'] as string | undefined,
      maxResults: cmdOpts['maxResults'] ? parseInt(String(cmdOpts['maxResults']), 10) : undefined,
      ask: cmdOpts['ask'] as boolean | undefined,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── diff ──────────────────────────────────────────────────────────────────────
program
  .command('diff')
  .description('Review a git diff with AI')
  .option('--staged', 'review staged changes')
  .option('--path <path>', 'limit diff to a specific path')
  .option('--no-review', 'just show the diff, no AI review')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runDiff } = await import('./commands/diff.js');
    await runDiff({
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      staged: cmdOpts['staged'] as boolean | undefined,
      path: cmdOpts['path'] as string | undefined,
      noReview: cmdOpts['review'] === false,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── review ────────────────────────────────────────────────────────────────────
program
  .command('review')
  .description('Review a branch or PR with AI')
  .option('--base <ref>', 'base branch or ref to diff against (default: main)')
  .option('--pr <number>', 'review a specific PR number (requires GitHub CLI)')
  .option('--json', 'output response as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runReview } = await import('./commands/review.js');
    await runReview({
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      base: cmdOpts['base'] as string | undefined,
      pr: cmdOpts['pr'] !== undefined ? parseInt(String(cmdOpts['pr']), 10) : undefined,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── commit ────────────────────────────────────────────────────────────────────
program
  .command('commit')
  .description('Generate an AI commit message from staged changes and commit')
  .option('--dry', 'generate the message but do not commit')
  .option('--yes', 'auto-confirm without prompting')
  .option('--amend', 'amend the last commit with a new AI-generated message')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runCommit } = await import('./commands/commit.js');
    await runCommit({
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      dry: cmdOpts['dry'] as boolean | undefined,
      yes: cmdOpts['yes'] as boolean | undefined,
      amend: cmdOpts['amend'] as boolean | undefined,
    });
  });

// ── patch ─────────────────────────────────────────────────────────────────────
program
  .command('patch [instruction]')
  .description('Generate and optionally apply a code patch')
  .option('--file <path...>', 'include these files as context')
  .option('--dry', 'generate the patch but do not offer to apply')
  .option('--yes', 'auto-confirm patch application')
  .action(async (instruction: string | undefined, cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runPatch } = await import('./commands/patch.js');
    await runPatch(instruction, {
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      file: cmdOpts['file'] as string[] | undefined,
      dry: cmdOpts['dry'] as boolean | undefined,
      yes: cmdOpts['yes'] as boolean | undefined,
    });
  });

// ── auth ──────────────────────────────────────────────────────────────────────
const auth = program.command('auth').description('Manage authentication credentials');

auth
  .command('login')
  .description('Validate credentials for the current provider')
  .action(async () => {
    const g = globalOpts();
    const { runAuthLogin } = await import('./commands/auth.js');
    await runAuthLogin({ profile: g.profile, provider: g.provider, model: g.model, baseUrl: g.baseUrl });
  });

auth
  .command('logout')
  .description('Remove stored credentials for the current provider')
  .action(async () => {
    const g = globalOpts();
    const { runAuthLogout } = await import('./commands/auth.js');
    await runAuthLogout({ profile: g.profile, provider: g.provider });
  });

// ── config ────────────────────────────────────────────────────────────────────
const config = program.command('config').description('Manage Jam configuration');

config
  .command('show')
  .description('Show merged configuration')
  .action(async () => {
    const g = globalOpts();
    const { runConfigShow } = await import('./commands/config.js');
    await runConfigShow({ profile: g.profile });
  });

config
  .command('init')
  .description('Initialize a config file')
  .option('--global', 'write to user config (~/.config/jam/config.json)')
  .action(async (opts: { global?: boolean }) => {
    const { runConfigInit } = await import('./commands/config.js');
    await runConfigInit({ global: opts.global });
  });

// ── models ────────────────────────────────────────────────────────────────────
const models = program.command('models').description('Model management');

models
  .command('list')
  .description('List available models for the current provider')
  .action(async () => {
    const g = globalOpts();
    const { runModelsList } = await import('./commands/models.js');
    await runModelsList({ profile: g.profile, provider: g.provider, baseUrl: g.baseUrl });
  });

// ── history ───────────────────────────────────────────────────────────────────
const history = program.command('history').description('Manage chat session history');

history
  .command('list')
  .description('List all saved chat sessions')
  .action(async () => {
    const { runHistoryList } = await import('./commands/history.js');
    await runHistoryList();
  });

history
  .command('show <sessionId>')
  .description('Show messages in a chat session')
  .action(async (sessionId: string) => {
    const { runHistoryShow } = await import('./commands/history.js');
    await runHistoryShow(sessionId);
  });

// ── completion ────────────────────────────────────────────────────────────────
const completion = program.command('completion').description('Shell completion scripts');

completion
  .command('install')
  .description('Print shell completion script and installation instructions')
  .option('--shell <shell>', 'target shell: bash or zsh (auto-detected if omitted)')
  .action(async (opts: { shell?: string }) => {
    const { runCompletionInstall } = await import('./commands/completion.js');
    runCompletionInstall({ shell: opts.shell });
  });

// ── context ───────────────────────────────────────────────────────────────────
const context = program.command('context').description('Manage the JAM.md project context file');

context
  .command('init')
  .description('Generate a JAM.md file with auto-discovered project context')
  .option('--force', 'overwrite existing JAM.md')
  .action(async (opts: { force?: boolean }) => {
    const { runContextInit } = await import('./commands/context.js');
    await runContextInit({ force: opts.force });
  });

context
  .command('show')
  .description('Display the current JAM.md contents')
  .action(async () => {
    const { runContextShow } = await import('./commands/context.js');
    await runContextShow();
  });

// ── doctor ────────────────────────────────────────────────────────────────────
program
  .command('doctor')
  .description('Run system diagnostics')
  .action(async () => {
    const g = globalOpts();
    const { runDoctor } = await import('./commands/doctor.js');
    await runDoctor({ profile: g.profile, provider: g.provider, baseUrl: g.baseUrl });
  });

// ── Default action (no subcommand): print banner then help ──────────────────
if (process.argv.slice(2).length === 0) {
  const noColor = process.argv.includes('--no-color');
  printLogo(noColor);
  program.help();
}

program.parse();
