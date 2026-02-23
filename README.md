<div align="center">

```
╭───────────────────────────────────╮
│                                   │
│      ██╗  █████╗  ███╗   ███╗     │
│      ██║ ██╔══██╗ ████╗ ████║     │
│      ██║ ███████║ ██╔████╔██║     │
│  ██  ██║ ██╔══██║ ██║╚██╔╝██║     │
│  ╚████╔╝ ██║  ██║ ██║ ╚═╝ ██║     │
│   ╚═══╝  ╚═╝  ╚═╝ ╚═╝     ╚═╝     │
│                                   │
│   developer-first  AI  CLI        │
│                                   │
╰───────────────────────────────────╯
```

# Jam CLI

**The developer-first AI assistant for the terminal.**

[![CI](https://github.com/sunilp/jam-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/sunilp/jam-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@sunilp-org/jam-cli.svg)](https://www.npmjs.com/package/@sunilp-org/jam-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org)

Ask questions • Explain code • Review diffs • Generate patches • Run agentic tasks

*All from your command line, powered by Ollama, OpenAI, Groq, or any compatible provider.*

[Getting Started](#quick-start) · [Commands](#commands) · [Configuration](#configuration) · [Contributing](#contributing) · [Security](#security-policy)

</div>

---

## Why Jam?

Most AI coding tools are built around a single vendor's model, require a browser or IDE plugin, and send your code to a remote server you don't control.

**Jam is different by design:**

- It runs **entirely on your machine** by default — your code never leaves your filesystem
- It is **not tied to any single model or provider** — you choose the engine; Jam is the harness
- It behaves like a proper **Unix tool** — pipeable, composable, and scriptable
- It treats **code modification as a transaction** — validate first, preview always, confirm before applying
- It is **built to be contributed to** — clean TypeScript, well-tested, architecture documented below

---

## Highlights

| | Feature | Description |
|---|---------|-------------|
| ⚡ | **Streaming output** | Responses begin rendering on the first token |
| 💬 | **Interactive chat** | Multi-turn sessions with history and resume |
| 📂 | **Repo-aware** | Explain files, search code, review diffs with full workspace context |
| 🩹 | **Patch workflow** | Generate unified diffs, validate, preview, and apply with confirmation |
| 🤖 | **Structured agent** | `jam run` uses a typed plan-then-execute loop: the model plans steps first, then executes with read-before-write safety and shrinkage guards |
| 🔌 | **Pluggable providers** | Ollama, OpenAI, Groq, **Embedded** built-in; adapter pattern for adding any LLM |
| 📦 | **Embedded inference** | **[Experimental]** Run without Ollama — tiny GGUF model runs directly in-process via `node-llama-cpp` |
| ⚙️ | **Layered config** | Global → repo → CLI flags; multiple named profiles |
| 🔐 | **Secure secrets** | OS keychain via keytar, env var fallback |
| 🐚 | **Shell completions** | Bash and Zsh |
| 🏠 | **Privacy-first** | Runs locally — your code never leaves your machine |

---

## Design Philosophy

> The best developer tools disappear into your workflow. They don't ask you to change how you work — they work the way you already do.

**You own the model.** Jam's `ProviderAdapter` is a clean interface — swap the AI engine with a config change, not a rewrite. No vendor lock-in, no model loyalty.

**Your code stays private.** The default is `localhost`. Nothing leaves your machine unless you explicitly point Jam at a remote provider. This isn't just a feature — it's the architecture.

**Changes are transactions, not actions.** `jam patch` validates with `git apply --check` before anything is touched, shows a full preview, and waits for explicit confirmation. No "undo" needed — changes never happen without your approval.

**Unix composability.** `jam ask` reads stdin, writes stdout, supports `--json`. It's a pipe stage, not a walled garden.

**Security is configuration, not hope.** Tool permissions (`toolPolicy`), allowed operations (`toolAllowlist`), and log redaction (`redactPatterns`) are declarative config — committable to `.jamrc` so your whole team inherits the same guardrails.

---

## Who Is Jam For?

| Situation | Why Jam fits |
|-----------|-------------|
| You work in a **security-sensitive codebase** | Local-only by default — nothing leaves your machine |
| You want to **use different models** for different tasks | Named profiles + provider adapter — switch with `--profile` |
| You live in the **terminal** and resent leaving it | Every command is designed for the shell, not a browser tab |
| You're on a **corporate network** that blocks AI services | Point `baseUrl` at an internal Ollama instance and you're done |
| You want an AI tool that fits into **CI/CD scripts** | `--json` output, stdin support, non-zero exit codes on errors |
| You want to **contribute to an AI tool** without fighting vendor APIs | The hard parts (streaming, tool-calling, config) are already built cleanly |

---

## Quick Start

### Provider Support

| Provider | Status | Notes |
|----------|--------|-------|
| **Ollama** | ✅ Default | Local inference via `ollama serve` |
| **OpenAI** | ✅ Supported | Requires `OPENAI_API_KEY` |
| **Groq** | ✅ Supported | Requires `GROQ_API_KEY` |
| **Embedded** | ⚗️ Experimental | In-process via `node-llama-cpp`, no server needed |

### Prerequisites

- **Node.js 20+**
- **One of the following model backends:**
  - **[Ollama](https://ollama.ai)** running locally (`ollama serve`) + a pulled model (`ollama pull llama3.2`)
  - **Embedded mode** — no server needed! Uses `node-llama-cpp` to run a tiny GGUF model in-process.
    Install with: `npm install node-llama-cpp` (auto-downloads a ~250 MB model on first run)

### Install

```bash
# Try instantly — no install required
npx @sunilp-org/jam-cli doctor

# Global install from npm
npm install -g @sunilp-org/jam-cli

# Homebrew (macOS / Linux)
brew tap sunilp/tap
brew install jam-cli

# Or run from source
git clone https://github.com/sunilp/jam-cli.git
cd jam-cli
npm install
npm run build
npm link          # makes `jam` available globally
```

### Verify

```bash
jam doctor        # checks Node version, config, provider connectivity, ripgrep
jam auth login    # validates connection to Ollama
```

---

## Commands

### `jam ask`

One-shot question. Streams the response to stdout.

```bash
jam ask "What is the difference between TCP and UDP?"

# From stdin
echo "Explain recursion in one paragraph" | jam ask

# From a file
jam ask --file prompt.txt

# JSON output (full response + token usage)
jam ask "What is 2+2?" --json

# Override model
jam ask "Hello" --model codellama

# Use a named profile
jam ask "Hello" --profile work
```

**Options:**

| Flag | Description |
|------|-------------|
| `--file <path>` | Read prompt from file |
| `--system <prompt>` | Override system prompt |
| `--json` | Machine-readable JSON output |
| `--model <id>` | Override model for this request |
| `--provider <name>` | Override provider |
| `--base-url <url>` | Override provider base URL |
| `--profile <name>` | Use a named config profile |
| `--no-tools` | Disable read-only tool use (file discovery) |
| `--no-color` | Strip ANSI colors from output (global flag) |
| `-q, --quiet` | Suppress all non-essential output (spinners, status lines, decorations) |

---

### `jam chat`

Interactive multi-turn chat REPL (Ink/React TUI).

```bash
jam chat                         # new session
jam chat --name "auth refactor"  # named session
jam chat --resume <sessionId>    # resume a previous session
```

**Keyboard shortcuts inside chat:**

| Key | Action |
|-----|--------|
| `Enter` | Submit message |
| `Ctrl-C` (once) | Interrupt current generation |
| `Ctrl-C` (twice) | Exit chat |

Sessions are saved automatically to `~/.local/share/jam/sessions/` (macOS: `~/Library/Application Support/jam/sessions/`).

---

### `jam explain`

Read one or more files and ask the model to explain them.

```bash
jam explain src/auth/middleware.ts
jam explain src/api/routes.ts src/api/handlers.ts
jam explain src/utils/retry.ts --json
```

---

### `jam search`

Search the codebase using ripgrep (falls back to JS if `rg` is not installed).

```bash
jam search "TODO"                          # plain search, prints results
jam search "useEffect" --glob "*.tsx"      # filter by file type
jam search "createServer" --ask            # pipe results to AI for explanation
jam search "error handling" --max-results 50
```

**Options:**

| Flag | Description |
|------|-------------|
| `--glob <pattern>` | Limit to files matching this glob (e.g. `*.ts`) |
| `--max-results <n>` | Max results (default: 20) |
| `--ask` | Send results to AI for analysis |
| `--json` | JSON output (with `--ask`) |

---

### `jam diff`

Run `git diff` and optionally review it with AI.

```bash
jam diff                    # review working tree changes
jam diff --staged           # review staged changes (ready to commit)
jam diff --path src/api/    # limit to a specific directory
jam diff --no-review        # just print the raw diff, no AI
jam diff --staged --json    # JSON output
```

---

### `jam review`

Review a branch or pull request with AI.

```bash
jam review                        # review current branch against main
jam review --base develop         # diff against a different base branch
jam review --pr 42                # review a specific PR (requires GitHub CLI)
jam review --json                 # JSON output
```

**Options:**

| Flag | Description |
|------|-------------|
| `--base <ref>` | Base branch or ref to diff against (default: `main`) |
| `--pr <number>` | Review a specific PR number (requires `gh` CLI) |
| `--json` | Machine-readable JSON output |

---

### `jam commit`

Generate an AI-written commit message from staged changes and commit.

```bash
jam commit                 # generate message, confirm, then commit
jam commit --dry           # generate message only, do not commit
jam commit --yes           # skip confirmation prompt
jam commit --amend         # amend the last commit with a new AI message
```

**Options:**

| Flag | Description |
|------|-------------|
| `--dry` | Generate the message but do not commit |
| `--yes` | Auto-confirm without prompting |
| `--amend` | Amend the last commit with a new AI-generated message |

Messages follow the [Conventional Commits](https://conventionalcommits.org) specification.

---

### `jam patch`

Ask the AI to generate a unified diff patch, validate it, and optionally apply it.

```bash
jam patch "Add input validation to the login function"
jam patch "Fix the off-by-one error in pagination" --file src/api/paginate.ts
jam patch "Add JSDoc comments to all public methods" --dry   # generate only, don't apply
jam patch "Remove unused imports" --yes                      # auto-confirm apply
```

**Flow:**
1. Collects context (git status, current diff, specified files)
2. Prompts the model for a unified diff
3. Validates with `git apply --check`
4. Shows the patch preview
5. Asks for confirmation (unless `--yes`)
6. Applies with `git apply`

---

### `jam run`

Agentic task workflow using a **structured plan-then-execute** loop. The model first generates a typed `ExecutionPlan` with ordered steps and success criteria, then executes each step with full safety enforcement.

```bash
jam run "Find all TODO comments and summarize them"
jam run "Check git status and explain what's changed"
jam run "Read src/config.ts and identify any security issues"
jam run "Add input validation to the login handler"   # involves writes
jam run --yes "Rename all occurrences of userId to accountId"  # auto-approve writes
```

**Options:**

| Flag | Description |
|------|-------------|
| `--yes` | Auto-approve all write tool confirmations (non-interactive) |
| `--model <id>` | Override model for this task |
| `--provider <name>` | Override provider |
| `--profile <name>` | Use a named config profile |
| `--json` | Machine-readable JSON output |

**How it works:**

1. **Plan** — model generates an ordered list of steps (read → understand → write) with explicit success criteria
2. **Execute** — each step runs in sequence; read-only results are cached to avoid redundant calls
3. **Read-before-write gate** — write tools are automatically blocked until the target file has been read first, preventing silent overwrites of unread files
4. **Shrinkage guard** — if a `write_file` produces a file suspiciously smaller than the original, the write is auto-reverted and the model is redirected
5. **Critic pass** — after the loop completes, a critic evaluates the result and injects a correction if quality is insufficient

**Available tools (model-callable):**

| Tool | Type | Description |
|------|------|-------------|
| `read_file` | Read | Read file contents |
| `list_dir` | Read | List directory contents |
| `search_text` | Read | Search codebase with ripgrep |
| `git_status` | Read | Get git status |
| `git_diff` | Read | Get git diff |
| `write_file` | **Write** | Write to a file (prompts for confirmation) |
| `apply_patch` | **Write** | Apply a unified diff (prompts for confirmation) |
| `run_command` | **Write** | Execute a shell command (dangerous patterns blocked; prompts for confirmation) |

Write tools require confirmation unless `toolPolicy` is set to `always` or `allowlist` in config.

---

### `jam auth`

```bash
jam auth login    # validate connectivity to the current provider
jam auth logout   # remove stored credentials from keychain
```

---

### `jam config`

```bash
jam config show            # print merged effective config as JSON
jam config init            # create .jam/config.json in the current directory
jam config init --global   # create ~/.config/jam/config.json
```

---

### `jam context`

Manage the `JAM.md` project context file. This file is auto-read by `jam ask` and `jam chat` to give the model awareness of your project's architecture, conventions, and goals.

```bash
jam context init           # generate JAM.md at the workspace root
jam context init --force   # overwrite an existing JAM.md
jam context show           # display the current JAM.md contents
```

---

### `jam models list`

```bash
jam models list            # list models available from the current provider
jam models list --provider ollama --base-url http://localhost:11434
```

---

### `jam history`

```bash
jam history list           # list all saved chat sessions
jam history show <id>      # show all messages in a session (first 8 chars of ID work)
```

---

### `jam completion install`

```bash
jam completion install                    # auto-detects shell
jam completion install --shell bash       # bash completion script
jam completion install --shell zsh        # zsh completion script
```

Follow the printed instructions to add the completion to your shell.

---

### `jam doctor`

Run system diagnostics:

```bash
jam doctor
```

Checks:
- Node.js version (≥ 20)
- Config file is valid
- Provider connectivity (Ollama reachable)
- ripgrep availability (optional, JS fallback used if absent)
- keytar availability (optional, env vars used if absent)

---

## Configuration

### Config File Locations

Jam merges config in priority order (highest wins):

```
1. CLI flags                              (--provider, --model, etc.)
2. .jam/config.json  or  .jamrc           (repo-level)
3. ~/.jam/config.json                     (user home-dir dotfile — preferred)
4. ~/.config/jam/config.json              (XDG user config — fallback)
5. Built-in defaults
```

> **Recommended:** Use `~/.jam/config.json` for your personal settings (provider, API keys, default model).  
> Use `.jam/config.json` at the repo root for project-specific overrides (tool policy, redact patterns).

### Config Schema

```json
{
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "provider": "ollama",
      "model": "llama3.2",
      "baseUrl": "http://localhost:11434",
      "temperature": 0.7,
      "maxTokens": 4096,
      "systemPrompt": "You are a helpful coding assistant."
    },
    "fast": {
      "provider": "ollama",
      "model": "qwen2.5-coder:1.5b",
      "baseUrl": "http://localhost:11434"
    },
    "embedded": {
      "provider": "embedded",
      "model": "smollm2-360m"
    }
  },
  "toolPolicy": "ask_every_time",
  "toolAllowlist": [],
  "historyEnabled": true,
  "logLevel": "warn",
  "redactPatterns": ["sk-[a-z0-9]+", "Bearer\\s+\\S+"]
}
```

### Config Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultProfile` | string | `"default"` | Active profile name |
| `profiles` | object | see below | Named provider/model configurations |
| `toolPolicy` | `ask_every_time` \| `always` \| `allowlist` \| `never` | `ask_every_time` | How write tools require confirmation |
| `toolAllowlist` | string[] | `[]` | Tools that never prompt (when policy is `allowlist`) |
| `historyEnabled` | boolean | `true` | Save chat sessions to disk |
| `logLevel` | `silent` \| `error` \| `warn` \| `info` \| `debug` | `warn` | Log verbosity |
| `redactPatterns` | string[] | `[]` | Regex patterns redacted from logs |

### Profile Fields

| Field | Type | Description |
|-------|------|-------------|
| `provider` | string | Provider name (`ollama`, `openai`, `groq`, `embedded`) |
| `model` | string | Model ID (e.g. `llama3.2`, `codellama`) |
| `baseUrl` | string | Provider API base URL |
| `apiKey` | string | API key (prefer keychain or env vars) |
| `temperature` | number | Sampling temperature (0–2) |
| `maxTokens` | number | Max tokens in response |
| `systemPrompt` | string | Default system prompt |

### Initialize Config

```bash
# User-level — creates ~/.jam/config.json (recommended)
jam config init --global

# Repo-level — creates .jam/config.json (committed to version control)
jam config init
```

The global config at `~/.jam/config.json` is the best place to set your default provider, model, API keys, and personal preferences. Edit it directly:

```bash
# Example: switch default provider to embedded
vim ~/.jam/config.json
```

```json
{
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "provider": "ollama",
      "model": "llama3.2",
      "baseUrl": "http://localhost:11434"
    },
    "openai": {
      "provider": "openai",
      "model": "gpt-4o-mini",
      "apiKey": "sk-..."
    },
    "offline": {
      "provider": "embedded",
      "model": "smollm2-360m"
    }
  },
  "toolPolicy": "ask_every_time",
  "historyEnabled": true,
  "logLevel": "warn"
}
```

### Using Profiles

```bash
# Use a specific profile
jam ask "Hello" --profile fast

# Switch default in config
echo '{"defaultProfile": "fast"}' > .jamrc
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `JAM_API_KEY` | API key fallback (if keytar unavailable) |
| `JAM_BASE_URL` | Override provider base URL |
| `OPENAI_API_KEY` | OpenAI API key (used when `provider: openai`) |
| `GROQ_API_KEY` | Groq API key (used when `provider: groq`) |

---

## Embedded Provider — Experimental ⚗️

> **⚠️ EXPERIMENTAL** — The embedded provider is functional but quality is limited by small model sizes. For production workloads, use Ollama or OpenAI.

The `embedded` provider runs a tiny GGUF model **directly in-process** via [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp). No Ollama installation, no server process, no network calls. **Models are only downloaded when you explicitly set `provider: "embedded"`** — it never downloads anything unless you opt in.

### Setup

```bash
# Install the native dependency (optional — only needed for embedded mode)
npm install node-llama-cpp

# Switch to embedded provider
jam ask "Hello" --provider embedded

# Or set it permanently in your config
jam config init --global   # then edit ~/.jam/config.json
```

### How It Works

1. On first use, Jam auto-downloads a small model (~250 MB) to `~/.jam/models/`
2. The model loads in-process using llama.cpp bindings — no external server
3. Streaming, tool-calling, and all standard commands work as usual

### Available Models

| Alias | Size (Q4_K_M) | Notes |
|-------|---------------|-------|
| `smollm2-135m` | ~100 MB | Ultra-light, very fast, basic quality |
| `smollm2-360m` | ~250 MB | **Default** — good quality-to-size ratio |
| `smollm2-1.7b` | ~1 GB | Best quality for embedded, needs more RAM |

```bash
# Use a specific embedded model alias
jam ask "Explain git rebase" --provider embedded --model smollm2-1.7b

# Or point to any local GGUF file
jam ask "Hello" --provider embedded --model /path/to/custom-model.gguf

# Profile-based setup
# In ~/.jam/config.json:
# {
#   "profiles": {
#     "offline": {
#       "provider": "embedded",
#       "model": "smollm2-1.7b"
#     }
#   }
# }
jam ask "Hello" --profile offline
```

### When to Use Embedded vs Ollama

| Scenario | Recommendation |
|----------|---------------|
| No Ollama / can't install system software | **Embedded** |
| CI/CD pipeline, Docker container, SSH box | **Embedded** |
| Air-gapped / offline machine | **Embedded** (after initial model download) |
| Want best quality & larger models (7B+) | **Ollama** |
| GPU acceleration needed | **Ollama** |
| Already have Ollama running | **Ollama** |

---

## Development

```bash
npm run dev -- ask "What is 2+2?"   # run from source with tsx
npm run build                         # compile TypeScript to dist/
npm run typecheck                     # tsc --noEmit
npm run lint                          # ESLint
npm test                              # Vitest unit tests
npm run test:watch                    # watch mode
npm run test:coverage                 # coverage report
```

### Project Structure

```
src/
├── index.ts        # CLI entry point — command registration (Commander)
├── commands/       # One file per command (ask, chat, run, review, commit, …)
├── providers/      # LLM adapter layer — ProviderAdapter interface + Ollama, Embedded impl
├── tools/          # Model-callable tools + registry + permission enforcement
├── config/         # Zod schema, cosmiconfig loader, built-in defaults
├── storage/        # Chat session persistence (JSON files)
├── ui/             # Ink/React TUI (chat REPL) + Markdown/streaming renderer
└── utils/          # Shared helpers: streaming, logger, secrets, agent loop, tokens
```

---

## Adding a New Provider

1. Implement `ProviderAdapter` from `src/providers/base.ts`:

```typescript
import type { ProviderAdapter, ProviderInfo, CompletionRequest, StreamChunk } from './base.js';

export class MyProvider implements ProviderAdapter {
  readonly info: ProviderInfo = { name: 'myprovider', supportsStreaming: true };

  async validateCredentials(): Promise<void> { /* ... */ }
  async listModels(): Promise<string[]> { /* ... */ }
  async *streamCompletion(request: CompletionRequest): AsyncIterable<StreamChunk> { /* ... */ }
}
```

2. Register in `src/providers/factory.ts`:

```typescript
if (provider === 'myprovider') {
  const { MyProvider } = await import('./myprovider.js');
  return new MyProvider({ apiKey: profile.apiKey });
}
```

3. Use: `jam ask "Hello" --provider myprovider`

---

## Contributing

Jam is intentionally built to be easy to extend. The architecture is layered, each concern is isolated, and the three main contribution surfaces — providers, tools, and commands — each have a clean interface to implement.

**You don't need to understand the whole codebase to contribute.** A new provider is one file. A new tool is one file. The patterns are already established and documented.

1. **Fork** the repository
2. **Create** your feature branch (`git checkout -b feat/amazing-feature`)
3. **Commit** your changes (`git commit -m 'feat: add amazing feature'`)
4. **Push** to the branch (`git push origin feat/amazing-feature`)
5. **Open** a Pull Request

Please read our [Contributing Guide](CONTRIBUTING.md) for details on our code of conduct, development workflow, and pull request process.

### Good First Issues

Look for issues labeled [`good first issue`](https://github.com/sunilp/jam-cli/labels/good%20first%20issue) — these are great starting points for new contributors.

### What the Codebase Looks Like

- **Strict TypeScript throughout** — no `any`, no guessing what a function does
- **Tests colocated with source** — `foo.ts` → `foo.test.ts`, using Vitest
- **One file per concern** — each command, provider, and tool is self-contained
- **Zod schema validation** — config is validated at load time, not at runtime when it's too late
- **Conventional Commits** — the git log tells the story of the project

If you can read TypeScript, you can contribute to Jam.

---

## Community

- **Issues** — [Report bugs or request features](https://github.com/sunilp/jam-cli/issues)
- **Discussions** — [Ask questions, share ideas](https://github.com/sunilp/jam-cli/discussions)
- **Code of Conduct** — [Our community standards](CODE_OF_CONDUCT.md)

---

## Security Policy

We take security seriously. If you discover a vulnerability, please **do not** open a public issue. Instead, follow the responsible disclosure process in our [Security Policy](SECURITY.md).

---

## Roadmap

- [x] OpenAI provider
- [ ] Azure OpenAI provider
- [ ] Anthropic Claude provider
- [x] Groq provider
- [ ] Plugin system for custom tools
- [ ] Token usage tracking and budgets
- [ ] Web UI companion

---

## Probable Enhancements

> Ideas and directions under consideration. These range from quick wins to deep architectural changes. Contributions, RFCs, and discussion on any of these are welcome.

### 🧩 Plugin System

The tool registry (`ToolRegistry.register()`) already accepts any `ToolDefinition`, but tool discovery is hardcoded. A proper plugin system would allow external tools without modifying source.

- **Local plugins** — load `ToolDefinition` modules from `.jam/plugins/` or `~/.config/jam/plugins/`
- **npm plugin packages** — `jam plugin install @scope/jam-plugin-docker` discovers and registers tools at startup
- **Plugin manifest** — declarative `jam-plugin.json` with name, version, tool definitions, required permissions
- **Lifecycle hooks** — `onActivate`, `onDeactivate`, `beforeToolCall`, `afterToolCall` for plugin-level middleware
- **Sandboxed execution** — plugins run with restricted filesystem/network access based on declared capabilities

```
jam plugin install jam-plugin-docker
jam plugin list
jam plugin remove jam-plugin-docker
```

### 🎯 Skills

Skills are named, composable mini-agents — each with a focused system prompt, a curated tool subset, and a defined output contract. Think of them as recipes the model can invoke.

- **Built-in skills** — `refactor`, `test-writer`, `documenter`, `security-audit`, `dependency-update`, `migration`
- **Skill registry** — each skill declares its name, description, required tools, system prompt template, and output schema
- **Composable** — skills can call other skills (e.g., `refactor` invokes `test-writer` to verify changes)
- **User-defined skills** — `.jam/skills/` directory with YAML/JSON skill definitions
- **Skill marketplace** — share and import community skills via npm or a registry

```yaml
# .jam/skills/api-endpoint.yaml
name: api-endpoint
description: Generate a new REST API endpoint with tests
tools: [read_file, write_file, search_text, run_command]
system: |
  You are an API endpoint generator. Given a resource name and
  fields, generate the route handler, validation, tests, and
  OpenAPI schema following the project's existing patterns.
output:
  type: files
  confirm: true
```

```bash
jam skill run refactor --file src/api/auth.ts
jam skill run test-writer --file src/utils/cache.ts
jam skill list
```

### 🤖 Sub-Agents & Task Decomposition

`jam run` now uses a **structured plan-then-execute** loop (typed `ExecutionPlan` with ordered steps, read-before-write enforcement, and a critic pass). The next evolution is true sub-agent decomposition — routing specialist child agents for independent sub-tasks.

- **Planner agent** — breaks a complex instruction into an ordered DAG of sub-tasks
- **Specialist delegation** — each sub-task dispatched to a purpose-built sub-agent (e.g., "read and understand", "refactor", "write tests", "verify")
- **Result aggregation** — parent agent collects sub-agent outputs and synthesizes a final result
- **Parallel sub-agents** — independent sub-tasks execute concurrently (e.g., "write tests" and "update docs" in parallel)
- **Scoped context** — each sub-agent receives only the context it needs, reducing token waste
- **Fail-and-retry isolation** — a failed sub-agent can be retried without restarting the entire task

```bash
jam run "Refactor the auth module to use JWT, update all tests, and document the changes"
# Planner decomposes into:
#   1. [understand] Read current auth module and tests
#   2. [refactor]   Rewrite auth module with JWT
#   3. [test]       Update tests for new implementation  (parallel with 4)
#   4. [document]   Update docs and JSDoc comments        (parallel with 3)
#   5. [verify]     Run tests and validate the patch
```

### 🔌 Connectors

Connectors are adapters for external services — bringing data in and pushing results out. Currently Jam only understands the local filesystem and git.

- **GitHub** — read/create issues, PRs, review comments; `jam review --pr 42` already shells out to `gh`, a connector would be native
- **GitLab / Bitbucket** — equivalent PR/MR workflows for non-GitHub teams
- **JIRA / Linear / Shortcut** — fetch issue context, update status, attach AI-generated summaries
- **Slack / Discord** — post review summaries, commit digests, or search results to channels
- **Database** — read schema, run read-only queries, explain query plans
- **REST / GraphQL** — generic HTTP connector for internal APIs (`jam ask "Why is /api/users slow?" --connector api-prod`)
- **Docker / K8s** — read container logs, describe pods, inspect images
- **CI/CD** — read build logs, trigger pipelines, analyze failures

```json
// .jam/config.json
{
  "connectors": {
    "github": { "token": "env:GITHUB_TOKEN" },
    "jira": { "baseUrl": "https://myorg.atlassian.net", "token": "env:JIRA_TOKEN" },
    "postgres": { "connectionString": "env:DATABASE_URL", "readOnly": true }
  }
}
```

### 🧠 MCP (Model Context Protocol) Support

[MCP](https://modelcontextprotocol.io) is an open standard for connecting AI models to external tools and data sources. Adding MCP client support would let Jam consume any MCP-compatible server.

- **MCP client** — Jam discovers and connects to MCP servers declared in config
- **Tool bridge** — MCP tools appear as native Jam tools in the registry, usable by `jam run`
- **Resource bridge** — MCP resources (files, database rows, API responses) injected as context
- **Prompt bridge** — MCP prompt templates available as Jam skills
- **Server mode** — expose Jam's own tools (read_file, search_text, git_diff, etc.) as an MCP server for other agents

```json
{
  "mcp": {
    "servers": {
      "filesystem": { "command": "npx @modelcontextprotocol/server-filesystem /path/to/dir" },
      "postgres":   { "command": "npx @modelcontextprotocol/server-postgres", "env": { "DATABASE_URL": "..." } }
    }
  }
}
```

### ⚡ Parallel Tool Execution

Currently tools execute sequentially within each agent round. When the model requests multiple independent tool calls (e.g., read three files), they could run concurrently.

- **Dependency analysis** — detect independent tool calls within a single round
- **Concurrent dispatch** — `Promise.all()` for independent read operations
- **Write serialization** — write tools always execute sequentially and with confirmation
- **Progress display** — show parallel tool execution status in real time

### 🔗 Middleware & Hooks

A middleware chain around LLM calls and tool executions, enabling cross-cutting concerns without modifying core logic.

- **Pre/post LLM hooks** — prompt injection defense, cost tracking, audit logging
- **Pre/post tool hooks** — rate limiting, output sanitization, metrics
- **Error interceptors** — custom retry logic, fallback providers, graceful degradation
- **Event emitter** — structured events (`tool:start`, `tool:end`, `llm:stream`, `agent:iteration`) for UI decoupling, telemetry, and external integrations

```typescript
// .jam/middleware/cost-tracker.ts
export default {
  name: 'cost-tracker',
  afterCompletion({ usage, provider, model }) {
    const cost = estimateCost(provider, model, usage);
    appendToLog(`~/.jam/cost.csv`, { timestamp: Date.now(), model, cost });
  }
};
```

### 🧭 Embeddings & Vector Search

The current past-session search uses keyword overlap (Jaccard scoring), and the symbol index is regex-based. Optional local embeddings would enable true semantic search.

- **Local embedding model** — use Ollama's embedding endpoint (`nomic-embed-text`, `mxbai-embed-large`) so nothing leaves your machine
- **Codebase index** — vector index of functions, classes, and doc comments stored at `.jam/vectors/`
- **Semantic code search** — `jam search "authentication flow"` returns semantically relevant code, not just keyword matches
- **Session memory** — embed past Q&A pairs for cross-session context recall with relevance decay
- **RAG pipeline** — retrieve relevant code chunks before prompting, reducing token usage and improving accuracy

### 💰 Cost & Token Tracking

`TokenUsage` is already captured per request but not aggregated or displayed.

- **Session cost estimation** — estimate cost based on provider pricing (configurable per-profile)
- **Budget limits** — `maxCostPerSession`, `maxCostPerDay` in config; warn or hard-stop when exceeded
- **Usage dashboard** — `jam usage` command showing tokens consumed, cost by model, by command, over time
- **Token budget per tool call** — prevent runaway context from a single large file read

```bash
jam usage                # summary: today, this week, this month
jam usage --detail       # per-session breakdown
jam usage --export csv   # export for expense tracking
```

### 📦 Multi-File Transactions

`apply_patch` and `write_file` currently operate on single files with no rollback mechanism.

- **Transaction block** — group multiple file writes into an atomic operation
- **Git stash checkpoint** — auto-stash before a multi-file edit, restore on failure
- **Dry-run preview** — show all proposed changes across files before any writes
- **Selective accept** — accept/reject individual file changes within a transaction

### 🔍 Provider Capabilities & Feature Negotiation

The `ProviderAdapter` interface treats all providers equally, but providers differ in capabilities.

- **Capability flags** — `supportsToolCalling`, `supportsVision`, `supportsStructuredOutput`, `supportsEmbeddings` on `ProviderInfo`
- **Graceful degradation** — if a provider doesn't support tool calling, fall back to prompt-based tool simulation
- **Model capability discovery** — query the provider for model-specific features at runtime
- **Auto-routing** — route tasks to the best-fit model/provider (e.g., use a fast model for planning, a capable model for generation)

### 🧠 Persistent Agent Memory

Working memory is currently session-scoped. Cross-session memory would make Jam smarter over time.

- **Workspace knowledge base** — facts, patterns, and conventions learned from past sessions, stored per-repo
- **Memory decay** — older memories lose relevance weight over time unless reinforced
- **Explicit memory** — `jam remember "the auth module uses bcrypt, not argon2"` for user-declared facts
- **Memory retrieval** — automatically surface relevant memories during planning and synthesis
- **Forgetting** — `jam forget` to clear or selectively prune memories

### 🌐 Web UI Companion

A local web interface for sessions that benefit from richer display.

- **Diff viewer** — syntax-highlighted side-by-side diffs for `jam patch` and `jam review`
- **Session browser** — visual history of past chat sessions with search
- **Tool call inspector** — expandable timeline of every tool call, its input, output, and duration
- **Markdown preview** — rendered Markdown responses with code block copy buttons
- **Served locally** — `jam ui` starts a local server; no external hosting

### 🧪 Testing & Verification Skills

First-class support for test generation and verification.

- **Test generation** — `jam test generate src/utils/cache.ts` generates tests matching project conventions
- **Test-driven patch** — `jam patch` can optionally run tests before and after applying changes
- **Coverage-aware context** — prioritize uncovered code paths in review and audit workflows
- **Regression detection** — track which tests fail after a patch and auto-revert if needed

### 🐚 Shell Integration & Workflow Automation

Deeper shell integration for power users and CI/CD pipelines.

- **Git hooks** — `jam hooks install` sets up pre-commit (auto-lint), prepare-commit-msg (AI message), pre-push (review)
- **Watch mode** — `jam watch` monitors file changes and provides continuous AI feedback
- **Pipeline mode** — structured JSON I/O for chaining Jam commands in shell scripts and CI
- **Makefile/Taskfile recipes** — pre-built task definitions for common workflows

---

## Acknowledgments

Built with these excellent open source projects:

- [Commander.js](https://github.com/tj/commander.js) — CLI framework
- [Ink](https://github.com/vadimdemedes/ink) — React for CLIs
- [Ollama](https://ollama.ai) — Local LLM serving
- [Zod](https://zod.dev) — Schema validation
- [marked](https://github.com/markedjs/marked) — Markdown rendering
- [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) — Configuration loading

---

## License

MIT License — Copyright (c) 2026-present **Sunil Prakash**. All rights reserved.

See [LICENSE](LICENSE) for the full license text.

---

<div align="center">

**Made with ❤️ by [Sunil Prakash](https://github.com/sunilp)**

If you find Jam useful, consider giving it a ⭐ on GitHub — it helps others discover the project!

</div>
