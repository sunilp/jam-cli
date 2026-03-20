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

// ── init ──────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Set up Jam in the current project (detect providers, create .jamrc and JAM.md)')
  .option('-y, --yes', 'auto-select defaults without prompting')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const { runInit } = await import('./commands/init.js');
    await runInit({ yes: cmdOpts['yes'] === true });
  });

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

// ── go ───────────────────────────────────────────────────────────────────────
program
  .command('go')
  .description('Interactive agent — reads, writes, and runs commands in your codebase')
  .option('--name <name>', 'name for the session')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runGo } = await import('./commands/go.js');
    await runGo({
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      name: cmdOpts['name'] as string | undefined,
    });
  });

// ── run ───────────────────────────────────────────────────────────────────────
function collect(val: string, memo: string[] = []) { memo.push(val); return memo; }

program
  .command('run [instruction]')
  .description('Execute a task workflow using AI and local tools')
  .option('-y, --yes', 'auto-approve all write tool calls without prompting')
  .option('--auto', 'fully autonomous mode (implies --yes)')
  .option('--workers <n>', 'max parallel workers for orchestrator')
  .option('--image <path>', 'attach image(s) for multimodal input', collect)
  .option('--no-sandbox', 'disable OS sandbox')
  .option('--file <path>', 'read prompt from file')
  .option('--json', 'output result as JSON')
  .action(async (instruction: string | undefined, cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runRun } = await import('./commands/run.js');
    await runRun(instruction, {
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      noColor: g.color === false,
      quiet: g.quiet,
      yes: cmdOpts['yes'] === true,
      auto: cmdOpts['auto'] as boolean | undefined,
      workers: cmdOpts['workers'] as string | undefined,
      image: cmdOpts['image'] as string[] | undefined,
      noSandbox: cmdOpts['sandbox'] === false,
      file: cmdOpts['file'] as string | undefined,
      json: cmdOpts['json'] as boolean | undefined,
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

// ── trace ────────────────────────────────────────────────────────────────────
program
  .command('trace [symbol]')
  .description('Trace the call graph of a function, class, or symbol across the codebase')
  .option('--depth <n>', 'upstream chain depth (default: 3)', '3')
  .option('--no-ai', 'skip AI analysis')
  .option('--json', 'output call graph as JSON')
  .action(async (symbol: string | undefined, cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runTrace } = await import('./commands/trace.js');
    await runTrace(symbol, {
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      noColor: g.color === false,
      quiet: g.quiet,
      depth: cmdOpts['depth'] ? parseInt(String(cmdOpts['depth']), 10) : undefined,
      noAi: cmdOpts['ai'] === false,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── verify ───────────────────────────────────────────────────────────────────
program
  .command('verify')
  .description('Validate changes — run checks, scan for secrets, assess risk')
  .option('--staged', 'verify only staged changes')
  .option('--base <ref>', 'diff against a base branch (e.g. main)')
  .option('--json', 'output structured JSON report')
  .option('--fail-on-risk <level>', 'exit 1 if risk >= level (low|medium|high|critical)')
  .option('--no-ai', 'skip AI risk assessment')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runVerify } = await import('./commands/verify.js');
    await runVerify({
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      noColor: g.color === false,
      quiet: g.quiet,
      staged: cmdOpts['staged'] as boolean | undefined,
      base: cmdOpts['base'] as string | undefined,
      json: cmdOpts['json'] as boolean | undefined,
      failOnRisk: cmdOpts['failOnRisk'] as 'low' | 'medium' | 'high' | 'critical' | undefined,
      noAi: cmdOpts['ai'] === false,
    });
  });

// ── jira ─────────────────────────────────────────────────────────────────
const jira = program.command('jira').description('Jira integration — browse and start working on issues');

jira
  .command('issues')
  .description('List Jira issues assigned to you')
  .option('--status <status...>', 'filter by status (e.g. "In Progress" "To Do")')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runJiraIssues } = await import('./commands/jira.js');
    await runJiraIssues({
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      noColor: g.color === false,
      quiet: g.quiet,
      status: cmdOpts['status'] as string[] | undefined,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

jira
  .command('start [key]')
  .description('Fetch issue details, create a branch, and generate an implementation plan')
  .option('--no-branch', 'skip branch creation')
  .action(async (key: string | undefined, cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runJiraStart } = await import('./commands/jira.js');
    await runJiraStart(key, {
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      noColor: g.color === false,
      quiet: g.quiet,
      noBranch: cmdOpts['branch'] === false,
    });
  });

jira
  .command('view [key]')
  .description('View full details of a Jira issue')
  .option('--json', 'output as JSON')
  .action(async (key: string | undefined, cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runJiraView } = await import('./commands/jira.js');
    await runJiraView(key, {
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      noColor: g.color === false,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── mcp ──────────────────────────────────────────────────────────────────
const mcp = program.command('mcp').description('Manage MCP (Model Context Protocol) servers');

mcp
  .command('list')
  .description('Connect to configured MCP servers and list their tools')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runMcpList } = await import('./commands/mcp.js');
    await runMcpList({
      profile: g.profile,
      provider: g.provider,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── cache ─────────────────────────────────────────────────────────────────
const cacheCmd = program.command('cache').description('Manage the response cache');

cacheCmd
  .command('stats')
  .description('Show cache statistics')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runCacheStats } = await import('./commands/cache.js');
    await runCacheStats({
      profile: g.profile,
      provider: g.provider,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

cacheCmd
  .command('clear')
  .description('Delete all cached responses')
  .action(async () => {
    const g = globalOpts();
    const { runCacheClear } = await import('./commands/cache.js');
    await runCacheClear({ profile: g.profile });
  });

cacheCmd
  .command('prune')
  .description('Remove expired cache entries')
  .action(async () => {
    const g = globalOpts();
    const { runCachePrune } = await import('./commands/cache.js');
    await runCachePrune({ profile: g.profile });
  });

// ── todo ─────────────────────────────────────────────────────────────────
program
  .command('todo')
  .description('Scan codebase for TODO/FIXME/HACK/XXX comments')
  .option('--by-author', 'group by git author')
  .option('--by-age', 'sort by age (oldest first)')
  .option('--type <types...>', 'filter by type (e.g. TODO FIXME)')
  .option('--pattern <regex>', 'custom pattern to match')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const { runTodo } = await import('./commands/todo.js');
    await runTodo({
      byAuthor: cmdOpts['byAuthor'] as boolean | undefined,
      byAge: cmdOpts['byAge'] as boolean | undefined,
      type: cmdOpts['type'] as string[] | undefined,
      pattern: cmdOpts['pattern'] as string | undefined,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── ports ────────────────────────────────────────────────────────────────
program
  .command('ports')
  .description('Show what is listening on your dev ports')
  .option('--kill <port>', 'kill process on a specific port')
  .option('--filter <term>', 'filter by port number, process, or command')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const { runPorts } = await import('./commands/ports.js');
    runPorts({
      kill: cmdOpts['kill'] as string | undefined,
      filter: cmdOpts['filter'] as string | undefined,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── recent ───────────────────────────────────────────────────────────────
program
  .command('recent')
  .description('Show recently modified files by git activity')
  .option('--days <n>', 'lookback period in days (default: 7)')
  .option('--author <name>', 'filter by git author')
  .option('--limit <n>', 'max files to show (default: 30)')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const { runRecent } = await import('./commands/recent.js');
    await runRecent({
      days: cmdOpts['days'] ? parseInt(String(cmdOpts['days']), 10) : undefined,
      author: cmdOpts['author'] as string | undefined,
      limit: cmdOpts['limit'] ? parseInt(String(cmdOpts['limit']), 10) : undefined,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── stats ────────────────────────────────────────────────────────────────
program
  .command('stats')
  .description('Codebase health dashboard — LOC, churn, complexity')
  .option('--sort <field>', 'sort languages by: code, files, lines (default: code)')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const { runStats } = await import('./commands/stats.js');
    await runStats({
      sort: cmdOpts['sort'] as string | undefined,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── hash ─────────────────────────────────────────────────────────────────
program
  .command('hash [paths...]')
  .description('Hash files or directories (.gitignore-aware)')
  .option('--algo <algorithm>', 'hash algorithm: sha256, sha1, md5 (default: sha256)')
  .option('--dirty', 'show modified files and their hashes')
  .option('--short', 'show short (12-char) hashes')
  .option('--check <file>', 'verify hashes from a checksum file')
  .option('--json', 'output as JSON')
  .action(async (paths: string[], cmdOpts: Record<string, unknown>) => {
    const { runHash } = await import('./commands/hash.js');
    await runHash(paths, {
      algo: cmdOpts['algo'] as string | undefined,
      dirty: cmdOpts['dirty'] as boolean | undefined,
      short: cmdOpts['short'] as boolean | undefined,
      check: cmdOpts['check'] as string | undefined,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── env ──────────────────────────────────────────────────────────────────
program
  .command('env')
  .description('Manage .env files — diff, validate, find missing vars, redact')
  .option('--diff', 'compare .env against .env.example')
  .option('--missing', 'show variables with empty values')
  .option('--redact', 'print .env with secrets redacted')
  .option('--validate', 'check for formatting issues')
  .option('--file <path>', 'env file to inspect (default: .env)')
  .option('--example <path>', 'example file for diffing')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const { runEnv } = await import('./commands/env.js');
    await runEnv({
      diff: cmdOpts['diff'] as boolean | undefined,
      missing: cmdOpts['missing'] as boolean | undefined,
      redact: cmdOpts['redact'] as boolean | undefined,
      validate: cmdOpts['validate'] as boolean | undefined,
      file: cmdOpts['file'] as string | undefined,
      example: cmdOpts['example'] as string | undefined,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── deps ─────────────────────────────────────────────────────────────────
program
  .command('deps')
  .description('Analyze import dependency graph — cycles, orphans, hotspots')
  .option('--circular', 'show only circular dependencies')
  .option('--orphans', 'show only orphan files (imported by nothing)')
  .option('--hotspots', 'show only import hotspots')
  .option('--src <dir>', 'limit to a source directory (e.g. src)')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const { runDeps } = await import('./commands/deps.js');
    await runDeps({
      circular: cmdOpts['circular'] as boolean | undefined,
      orphans: cmdOpts['orphans'] as boolean | undefined,
      hotspots: cmdOpts['hotspots'] as boolean | undefined,
      src: cmdOpts['src'] as string | undefined,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── dup ──────────────────────────────────────────────────────────────────
program
  .command('dup')
  .description('Detect near-duplicate code blocks')
  .option('--min-lines <n>', 'minimum block size in lines (default: 6)')
  .option('--threshold <n>', 'similarity threshold 0-1 (default: 0.8)')
  .option('--glob <pattern>', 'limit to files matching glob')
  .option('--limit <n>', 'max duplicates to report (default: 20)')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const { runDup } = await import('./commands/dup.js');
    await runDup({
      minLines: cmdOpts['minLines'] ? parseInt(String(cmdOpts['minLines']), 10) : undefined,
      threshold: cmdOpts['threshold'] ? parseFloat(String(cmdOpts['threshold'])) : undefined,
      glob: cmdOpts['glob'] as string | undefined,
      limit: cmdOpts['limit'] ? parseInt(String(cmdOpts['limit']), 10) : undefined,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── json ─────────────────────────────────────────────────────────────────
program
  .command('json [file]')
  .description('JSON swiss knife — pretty print, query, diff, minify')
  .option('--query <path>', 'extract value by dot-path (e.g. "users[0].name")')
  .option('--diff <file>', 'diff against another JSON file')
  .option('--minify', 'output minified JSON')
  .option('--sort-keys', 'sort object keys alphabetically')
  .option('--flatten', 'flatten nested objects to dot-path keys')
  .option('--no-color', 'disable colored output')
  .action(async (file: string | undefined, cmdOpts: Record<string, unknown>) => {
    const { runJson } = await import('./commands/json.js');
    await runJson(file, {
      query: cmdOpts['query'] as string | undefined,
      diff: cmdOpts['diff'] as string | undefined,
      minify: cmdOpts['minify'] as boolean | undefined,
      sortKeys: cmdOpts['sortKeys'] as boolean | undefined,
      flatten: cmdOpts['flatten'] as boolean | undefined,
      color: cmdOpts['color'] as boolean | undefined,
    });
  });

// ── convert ──────────────────────────────────────────────────────────────
program
  .command('convert [file]')
  .description('Convert between formats — JSON, YAML, CSV, Base64, URL, Hex')
  .option('--from <format>', 'input format (auto-detected if omitted)')
  .option('--to <format>', 'output format (json, yaml, csv, base64, url, hex)')
  .action(async (file: string | undefined, cmdOpts: Record<string, unknown>) => {
    const { runConvert } = await import('./commands/convert.js');
    await runConvert(file, {
      from: cmdOpts['from'] as string | undefined,
      to: cmdOpts['to'] as string | undefined,
    });
  });

// ── pack ─────────────────────────────────────────────────────────────────
program
  .command('pack')
  .description('Package analyzer — deps, size, unused detection, scripts')
  .option('--unused', 'show potentially unused dependencies')
  .option('--size', 'show dependency size breakdown')
  .option('--scripts', 'list available npm scripts')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const { runPack } = await import('./commands/pack.js');
    await runPack({
      unused: cmdOpts['unused'] as boolean | undefined,
      size: cmdOpts['size'] as boolean | undefined,
      scripts: cmdOpts['scripts'] as boolean | undefined,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

// ── http ─────────────────────────────────────────────────────────────────
program
  .command('http [method] [url]')
  .description('Quick HTTP client with pretty JSON output')
  .option('-H, --header <header...>', 'request headers (e.g. "Content-Type: application/json")')
  .option('-d, --body <body>', 'request body (prefix with @ to read from file)')
  .option('--bearer <token>', 'set Authorization: Bearer header')
  .option('--json', 'force JSON output formatting')
  .option('--timing', 'show request timing details')
  .option('-v, --verbose', 'show response headers')
  .option('-o, --output <file>', 'save response body to file')
  .option('--no-color', 'disable colored output')
  .action(async (method: string | undefined, url: string | undefined, cmdOpts: Record<string, unknown>) => {
    const { runHttp } = await import('./commands/http.js');
    await runHttp(method, url, {
      header: cmdOpts['header'] as string[] | undefined,
      body: cmdOpts['body'] as string | undefined,
      bearer: cmdOpts['bearer'] as string | undefined,
      json: cmdOpts['json'] as boolean | undefined,
      timing: cmdOpts['timing'] as boolean | undefined,
      verbose: cmdOpts['verbose'] as boolean | undefined,
      output: cmdOpts['output'] as string | undefined,
      noColor: cmdOpts['color'] === false,
    });
  });

// ── md2pdf ───────────────────────────────────────────────────────────────────
program
  .command('md2pdf [file]')
  .description('Convert a Markdown file to PDF')
  .option('-o, --output <path>', 'output file path (default: <input>.pdf)')
  .option('--title <title>', 'PDF document title')
  .option('--style <name>', 'style preset: default, minimal, academic')
  .option('--font-size <n>', 'body font size (default: 11)')
  .action(async (file: string | undefined, cmdOpts: Record<string, unknown>) => {
    const { runMd2Pdf } = await import('./commands/md2pdf.js');
    await runMd2Pdf(file, {
      output: cmdOpts['output'] as string | undefined,
      title: cmdOpts['title'] as string | undefined,
      style: cmdOpts['style'] as string | undefined,
      fontSize: cmdOpts['fontSize'] ? parseInt(String(cmdOpts['fontSize']), 10) : undefined,
    });
  });

// ── diagram ──────────────────────────────────────────────────────────────────
program
  .command('diagram [scope]')
  .description('Generate architecture diagrams from code analysis (Mermaid output)')
  .option('--type <type>', 'diagram type: architecture, deps, flow, class (default: architecture)')
  .option('-o, --output <file>', 'write Mermaid output to file instead of stdout')
  .option('--json', 'output raw analysis data as JSON (no AI)')
  .option('--no-ai', 'generate a deterministic diagram without AI')
  .option('--focus <module>', 'highlight a specific module and its connections')
  .option('--exclude <dirs>', 'comma-separated directories to exclude')
  .action(async (scope: string | undefined, cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runDiagram } = await import('./commands/diagram.js');
    await runDiagram(scope, {
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      noColor: g.color === false,
      quiet: g.quiet,
      type: cmdOpts['type'] as string | undefined,
      output: cmdOpts['output'] as string | undefined,
      json: cmdOpts['json'] as boolean | undefined,
      noAi: cmdOpts['ai'] === false,
      focus: cmdOpts['focus'] as string | undefined,
      exclude: cmdOpts['exclude'] as string | undefined,
    });
  });

// ── intel ─────────────────────────────────────────────────────────────────────
const intel = program.command('intel').description('Codebase intelligence — analyze, query, visualize');

intel.command('scan')
  .description('Scan codebase and build knowledge graph')
  .option('--no-enrich', 'Skip LLM enrichment')
  .option('--enrich <depth>', 'Enrichment depth: shallow or deep')
  .option('--dry-run', 'Show scan estimate without running')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runIntelScan } = await import('./commands/intel.js');
    // Commander sets enrich=false when --no-enrich is passed; map to noEnrich flag
    const enrichVal = cmdOpts['enrich'];
    await runIntelScan({
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      noColor: g.color === false,
      noEnrich: enrichVal === false,
      enrich: typeof enrichVal === 'string' ? enrichVal : undefined,
      dryRun: cmdOpts['dryRun'] as boolean | undefined,
    });
  });

intel.command('status')
  .description('Show knowledge graph stats and enrichment progress')
  .action(async () => {
    const { runIntelStatus } = await import('./commands/intel.js');
    await runIntelStatus();
  });

intel.command('query <text>')
  .description('Query the knowledge graph')
  .option('--no-ai', 'Use keyword search only (offline)')
  .option('--mermaid', 'Output result as Mermaid diagram')
  .action(async (text: string, cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runIntelQuery } = await import('./commands/intel.js');
    await runIntelQuery(text, { profile: g.profile, provider: g.provider, model: g.model, baseUrl: g.baseUrl, noAi: cmdOpts['ai'] === false, mermaid: cmdOpts['mermaid'] as boolean | undefined });
  });

intel.command('impact <file>')
  .description('Show impact analysis for a file')
  .option('--mermaid', 'Output as Mermaid diagram')
  .action(async (file: string, cmdOpts: Record<string, unknown>) => {
    const { runIntelImpact } = await import('./commands/intel.js');
    await runIntelImpact(file, { mermaid: cmdOpts['mermaid'] as boolean | undefined });
  });

intel.command('diagram')
  .description('Generate architecture diagram')
  .option('--type <type>', 'architecture, flow, deps, framework', 'architecture')
  .option('-o, --output <file>', 'Output file path')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const { runIntelDiagram } = await import('./commands/intel.js');
    await runIntelDiagram({ type: cmdOpts['type'] as string | undefined, output: cmdOpts['output'] as string | undefined });
  });

intel.command('explore')
  .description('Open knowledge graph in browser')
  .action(async () => {
    const { runIntelExplore } = await import('./commands/intel.js');
    await runIntelExplore();
  });

// ── plugin ───────────────────────────────────────────────────────────────────
const pluginCmd = program.command('plugin').description('Manage jam plugins');

pluginCmd
  .command('list')
  .description('List installed plugins')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const { runPluginList } = await import('./commands/plugin.js');
    await runPluginList({ json: cmdOpts['json'] as boolean | undefined });
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

// ── Plugin loading ───────────────────────────────────────────────────────────
async function loadPlugins(): Promise<void> {
  try {
    const { homedir } = await import('node:os');
    const { existsSync } = await import('node:fs');
    const { PluginManager } = await import('./plugins/manager.js');
    const { loadConfig } = await import('./config/loader.js');
    const { getWorkspaceRoot } = await import('./utils/workspace.js');
    const { printError, printWarning, printSuccess } = await import('./ui/renderer.js');

    const config = await loadConfig(process.cwd());

    const pluginDirs = [
      join(homedir(), '.jam', 'plugins'),
    ];

    // Add workspace-level plugins if in a git repo
    try {
      const wsRoot = await getWorkspaceRoot();
      pluginDirs.push(join(wsRoot, '.jam', 'plugins'));
    } catch { /* not in a git repo — skip workspace plugins */ }

    // Add config-level plugin directories
    if (config.pluginDirs) {
      pluginDirs.push(...config.pluginDirs);
    }

    // Only proceed if at least one plugin directory exists
    if (!pluginDirs.some((d) => existsSync(d))) return;

    const manager = new PluginManager();
    await manager.loadAll(pluginDirs, {
      enabled: config.enabledPlugins,
      disabled: config.disabledPlugins,
    });

    if (manager.hasPlugins) {
      let wsRoot = process.cwd();
      try { wsRoot = await getWorkspaceRoot(); } catch { /* use cwd */ }

      await manager.registerAll(program, {
        workspaceRoot: wsRoot,
        ui: { printError, printWarning, printSuccess },
      });
    }
  } catch {
    // Plugin loading is non-fatal — silently continue
  }
}

// ── git ─────────────────────────────────────────────────────────────────
const gitCmd = program
  .command('git')
  .description('Git productivity toolkit — status explained, smart undo, cleanup, standup');

gitCmd
  .command('wtf')
  .description('Explain the current git state in plain English')
  .action(async () => {
    const { runGitWtf } = await import('./commands/git-tools.js');
    runGitWtf();
  });

gitCmd
  .command('undo')
  .description('Detect and suggest how to undo the last git operation')
  .option('--dry', 'preview only, do not execute')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const { runGitUndo } = await import('./commands/git-tools.js');
    runGitUndo({ dryRun: cmdOpts['dry'] as boolean | undefined });
  });

gitCmd
  .command('cleanup')
  .description('Remove merged branches, prune stale remotes')
  .option('--dry', 'preview only, do not delete')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const { runGitCleanup } = await import('./commands/git-tools.js');
    runGitCleanup({
      dryRun: cmdOpts['dry'] as boolean | undefined,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

gitCmd
  .command('standup')
  .description('Show your recent commits across all branches')
  .option('--days <n>', 'number of days to look back (default: 1)', '1')
  .option('--author <name>', 'filter by author (default: you)')
  .option('--json', 'output as JSON')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const { runGitStandup } = await import('./commands/git-tools.js');
    runGitStandup({
      days: parseInt(cmdOpts['days'] as string) || 1,
      author: cmdOpts['author'] as string | undefined,
      json: cmdOpts['json'] as boolean | undefined,
    });
  });

gitCmd
  .command('oops')
  .description('Quick reference for common git mistakes and their fixes')
  .action(async () => {
    const { runGitOops } = await import('./commands/git-tools.js');
    runGitOops();
  });

// ── vibes (hidden easter egg) ────────────────────────────────────────────
program
  .command('vibes', { hidden: true })
  .action(async () => {
    const { runVibes } = await import('./commands/vibes.js');
    await runVibes();
  });

// ── Default action (no subcommand): print banner then help ──────────────────
if (process.argv.slice(2).length === 0) {
  const noColor = process.argv.includes('--no-color');
  printLogo(noColor);
  program.help();
}

// Load plugins then parse
await loadPlugins();
program.parse();
