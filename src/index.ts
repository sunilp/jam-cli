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

// ── agent ─────────────────────────────────────────────────────────────────────
program
  .command('agent [task]')
  .description('Run the coding agent harness on a task')
  .option('--task-file <path>', 'read the task from a file')
  .option('--verify <cmd>', 'additional verification command', (v: string, acc: string[]) =>
    [...acc, v], [] as string[])
  .option('--json', 'emit the session journal as newline-delimited JSON')
  .option('--max-tool-calls <n>', 'tool call budget', '200')
  .option('--timeout <ms>', 'wall clock budget in milliseconds', String(30 * 60_000))
  .action(async (task: string | undefined, cmdOpts: Record<string, unknown>) => {
    const { runAgentCommand } = await import('./commands/agent.js');
    const g = globalOpts();
    process.exitCode = await runAgentCommand(task, cmdOpts, {
      provider: g.provider, model: g.model, profile: g.profile,
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

models
  .command('set <model>')
  .description('Set the default model for the current provider')
  .action(async (model: string) => {
    const g = globalOpts();
    const { runModelsSet } = await import('./commands/models.js');
    await runModelsSet(model, { profile: g.profile, provider: g.provider, baseUrl: g.baseUrl });
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
  .option('--depth <n>', 'upstream chain depth (default: 10)', '10')
  .option('--no-ai', 'skip AI analysis')
  .option('--json', 'output call graph as JSON')
  .option('--impact', 'show what breaks if symbol changes')
  .option('--reindex', 'force rebuild trace index')
  .option('--lang <lang>', 'override language detection')
  .option('--mermaid', 'output as Mermaid diagram')
  .option('--data-lineage', 'trace column/variable flow (Phase 2)')
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
      impact: cmdOpts['impact'] as boolean | undefined,
      reindex: cmdOpts['reindex'] as boolean | undefined,
      lang: cmdOpts['lang'] as string | undefined,
      mermaid: cmdOpts['mermaid'] as boolean | undefined,
      dataLineage: cmdOpts['dataLineage'] as boolean | undefined,
    });
  });

// ── impact ───────────────────────────────────────────────────────────────────
program
  .command('impact [symbol]')
  .description('Show cross-language impact of changing a symbol or column (shortcut for `trace --impact`)')
  .option('--depth <n>', 'upstream chain depth (default: 10)', '10')
  .option('--no-ai', 'skip AI analysis')
  .option('--json', 'output as JSON')
  .option('--reindex', 'force rebuild trace index')
  .option('--lang <lang>', 'override language detection')
  .option('--mermaid', 'output as Mermaid diagram')
  .action(async (symbol: string | undefined, cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runImpact } = await import('./commands/impact.js');
    await runImpact(symbol, {
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      noColor: g.color === false,
      quiet: g.quiet,
      depth: cmdOpts['depth'] ? parseInt(String(cmdOpts['depth']), 10) : undefined,
      noAi: cmdOpts['ai'] === false,
      json: cmdOpts['json'] as boolean | undefined,
      reindex: cmdOpts['reindex'] as boolean | undefined,
      lang: cmdOpts['lang'] as string | undefined,
      mermaid: cmdOpts['mermaid'] as boolean | undefined,
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

// ── browser ──────────────────────────────────────────────────────────────────
const browserCmd = program
  .command('browser')
  .description('AI-driven browser automation via Playwright');

browserCmd
  .command('launch [prompt]')
  .description('Launch an interactive AI-driven browser session')
  .option('--url <url>', 'open browser at this URL')
  .action(async (prompt: string | undefined, cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runBrowserLaunch } = await import('./commands/browser.js');
    await runBrowserLaunch({
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      url: cmdOpts['url'] as string | undefined,
    }, prompt);
  });

browserCmd
  .command('record')
  .description('Launch browser and record all interactions to a session file')
  .option('--url <url>', 'open browser at this URL')
  .option('--output <path>', 'output file path for the session recording')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runBrowserRecord } = await import('./commands/browser.js');
    await runBrowserRecord({
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      url: cmdOpts['url'] as string | undefined,
      output: cmdOpts['output'] as string | undefined,
    });
  });

// ── Default action (no subcommand): print banner then help ──────────────────
if (process.argv.slice(2).length === 0) {
  const noColor = process.argv.includes('--no-color');
  printLogo(noColor);
  program.help();
}

// ── Archived commands — print a clear migration pointer before commander's default
const ARCHIVED_COMMANDS = new Set([
  'ask', 'chat', 'run', 'go', 'explain', 'review', 'verify',
  'patch', 'commit', 'diff', 'jira', 'md2pdf', 'intel',
]);

function maybePrintArchivePointer(): boolean {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd && ARCHIVED_COMMANDS.has(cmd)) {
    process.stderr.write(
      `\n  jam: '${cmd}' was removed in v0.12.0.\n\n` +
      `  This command lives on the archive/ai-suite branch and may return in a future release.\n` +
      `  See: https://github.com/sunilp/jam-cli/tree/archive/ai-suite/src/commands/${cmd}.ts\n` +
      `  Why removed: https://github.com/sunilp/jam-cli/blob/main/CHANGELOG.md#v0120\n\n`
    );
    return true;
  }
  return false;
}

// Load plugins then parse
await loadPlugins();
if (maybePrintArchivePointer()) {
  process.exit(2);
}
program.parse();
