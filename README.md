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

Ask questions · Trace call graphs · Review diffs · Generate patches · Run agentic tasks · Connect to MCP servers · Generate diagrams · Plugin system · 14 built-in dev utilities

*All from your command line, powered by Ollama, OpenAI, Anthropic, Groq, or any compatible provider.*

[Getting Started](#quick-start) · [Commands](#commands) · [Utilities](#developer-utilities-zero-llm) · [MCP](#jam-mcp) · [Plugins](#plugin-system) · [Configuration](#configuration) · [Contributing](#contributing)

</div>

---

> ### What's New in v0.6.0
>
> **Plugin system** — Extend Jam with custom commands. Drop a plugin into `~/.jam/plugins/` with a `jam-plugin.json` manifest and an `index.js` entry point. Supports enable/disable lists, project-level plugins, and conflict detection. [Full docs](docs/plugins.md)
>
> **`jam diagram`** — Generate Mermaid architecture diagrams from your codebase. Static analysis maps modules, dependencies, symbols, and cycles. AI refinement optional. Supports architecture, deps, class, and flow diagram types. [Full docs](docs/diagram.md)
>
> **`jam md2pdf`** — Convert Markdown files to PDF with three style presets (default, minimal, academic). Supports headings, code blocks, tables, lists, links, and more.
>
> **14 zero-LLM developer utilities** — `jam todo`, `jam ports`, `jam recent`, `jam stats`, `jam hash`, `jam env`, `jam deps`, `jam dup`, `jam json`, `jam convert`, `jam pack`, `jam http`, `jam md2pdf`, `jam diagram --no-ai`. [Full docs](docs/utilities.md)

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
| 🔍 | **Call graph tracing** | `jam trace` maps any symbol's callers, callees, imports, and upstream chain with Mermaid diagrams |
| 🩹 | **Patch workflow** | Generate unified diffs, validate, preview, and apply with confirmation |
| 🤖 | **Structured agent** | `jam run` uses a typed plan-then-execute loop with read-before-write safety and shrinkage guards |
| 🎫 | **Jira integration** | Browse assigned issues, auto-create branches, generate implementation plans |
| ✅ | **Verification pipeline** | `jam verify` scans for secrets, runs checks, and assesses risk before you ship |
| 📝 | **Smart commits** | Auto-detects your project's commit convention (Conventional Commits, JIRA prefixes, etc.) |
| 🔌 | **5 providers** | Ollama, OpenAI, Anthropic, Groq, Embedded — adapter pattern for adding any LLM |
| 🧠 | **Auto-detection** | `--model claude-sonnet-4-20250514` auto-selects the right provider — no `--provider` needed |
| 💾 | **Response caching** | Identical prompts return cached results instantly — saves API calls and money |
| 📦 | **Embedded inference** | **[Experimental]** Tiny GGUF model runs directly in-process via `node-llama-cpp` |
| ⚙️ | **Layered config** | Global → repo → CLI flags; multiple named profiles |
| 🔐 | **Secure secrets** | OS keychain via keytar, env var fallback |
| 🐚 | **Shell completions** | Bash and Zsh |
| 🏠 | **Privacy-first** | Runs locally — your code never leaves your machine |
| 🔗 | **MCP support** | Connect to any Model Context Protocol server — with governance, groups, and per-server policies |
| 🔌 | **Plugin system** | Drop custom commands into `~/.jam/plugins/` — manifest-based, enable/disable, project-level |
| 📊 | **Diagram generation** | `jam diagram` generates Mermaid architecture diagrams from static code analysis |
| 📄 | **Markdown to PDF** | `jam md2pdf` converts `.md` files to styled PDFs with three presets |
| 🧰 | **14 dev utilities** | `todo`, `ports`, `stats`, `deps`, `dup`, `env`, `hash`, `json`, `convert`, `http`, `pack`, `recent`, `md2pdf`, `diagram` — zero LLM required |

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
| **Anthropic** | ✅ Supported | Requires `ANTHROPIC_API_KEY`; Claude models with tool calling |
| **Groq** | ✅ Supported | Requires `GROQ_API_KEY` |
| **Embedded** | ⚗️ Experimental | In-process via `node-llama-cpp`, no server needed |

**Provider auto-detection:** You don't need to specify `--provider` if you pass a model name. Jam infers the provider automatically:

```bash
jam ask "Hello" --model claude-sonnet-4-20250514    # → anthropic
jam ask "Hello" --model gpt-4o                  # → openai
jam ask "Hello" --model llama-3.1-8b-instant    # → groq
```

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

### First Run

```bash
jam init          # interactive setup — detects providers, creates .jamrc + JAM.md
jam doctor        # checks Node version, config, provider connectivity, ripgrep
jam auth login    # validates connection to the configured provider
```

---

## Commands

### `jam init`

Interactive onboarding wizard. Detects available providers (Ollama running? API keys set?), lets you choose, creates `.jamrc` and `JAM.md`, and verifies connectivity.

```bash
jam init              # interactive provider selection + config creation
jam init --yes        # auto-select the best available provider
```

---

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

# Override model (provider auto-detected)
jam ask "Hello" --model claude-sonnet-4-20250514

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

### `jam trace`

Trace the complete call graph of any function, class, or symbol across the codebase. Shows definition, callers, callees, import chain, upstream caller hierarchy, and a Mermaid diagram — all by default.

```bash
jam trace createProvider                # full trace with AI analysis + Mermaid diagram
jam trace JamError --depth 1            # shallow upstream chain
jam trace loadConfig --no-ai            # skip AI, just show the graph
jam trace buildCallGraph --json         # structured JSON output
```

**Example output:**

```
  Call Graph
  ────────────────────────────────────────────────────────────

  createProvider(profile: Profile) → Promise<ProviderAdapter>
    Defined: src/providers/factory.ts:30  [function]

    Imported by:
    │ src/commands/ask.ts:3
    │ src/commands/commit.ts:5
    │ src/commands/diff.ts:4
    ...

    Called from:
    ├─ src/commands/ask.ts:138      createProvider(profile)
    ├─ src/commands/commit.ts:413   createProvider(profile)
    ├─ src/commands/diff.ts:56      createProvider(profile)
    └─ src/commands/run.ts:72       createProvider(profile)

    Calls into:
    ├─ OllamaAdapter({)    [(workspace)]
    ├─ OpenAIAdapter({)    [(workspace)]
    ├─ AnthropicAdapter({) [(workspace)]
    └─ GroqAdapter({)      [(workspace)]

  Mermaid Diagram
  ────────────────────────────────────────────────────────────

  ```mermaid
  graph TD
    createProvider["createProvider ..."]
    ask["ask.ts:138"] --> createProvider
    commit["commit.ts:413"] --> createProvider
    ...
  ```

  AI Analysis
  ────────────────────────────────────────────────────────────

  **Flow Summary:** createProvider is the central factory for LLM adapters...
```

**Options:**

| Flag | Description |
|------|-------------|
| `--depth <n>` | Upstream chain depth (default: 3) |
| `--no-ai` | Skip AI analysis, show only the graph |
| `--json` | Output the raw call graph as JSON |

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

Generate an AI-written commit message from staged changes and commit. Jam auto-detects your project's commit convention from git history — Conventional Commits, JIRA prefixes (`PROJ-123: ...`), bracket tickets (`[PROJ-123] ...`), or any consistent pattern.

```bash
jam commit                 # generate message, confirm, then commit
jam commit --dry           # generate message only, do not commit
jam commit --yes           # skip confirmation prompt
jam commit --amend         # amend the last commit with a new AI message
```

**Convention detection:**

Jam samples the last 20 commits and detects the dominant pattern:

```
Detected convention: {ticket}: {type}({scope}): {description}
Generating commit message...

  PROJ-456: feat(auth): add OAuth2 token refresh
```

You can also configure conventions explicitly in `.jamrc`:

```json
{
  "commitConvention": {
    "format": "{ticket}: {type}: {description}",
    "ticketPattern": "PROJ-\\d+",
    "ticketRequired": true,
    "types": ["feat", "fix", "chore", "docs"],
    "rules": ["Always reference the module name in scope"]
  }
}
```

**Options:**

| Flag | Description |
|------|-------------|
| `--dry` | Generate the message but do not commit |
| `--yes` | Auto-confirm without prompting |
| `--amend` | Amend the last commit with a new AI-generated message |

---

### `jam verify`

Validation pipeline for changes. Runs checks, scans for secrets, and assesses risk before you ship.

```bash
jam verify                          # verify current working tree changes
jam verify --staged                 # verify only staged changes
jam verify --base main              # diff against a base branch
jam verify --json                   # structured JSON report
jam verify --fail-on-risk high      # exit 1 if risk >= high (for CI)
jam verify --no-ai                  # skip AI risk assessment
```

**Checks run:**

| Check | Weight | What it does |
|-------|--------|-------------|
| Diff sanity | — | Verifies changes exist and aren't too large |
| Secret scan | 0.4 | 10 patterns: API keys, tokens, passwords, private keys, connection strings |
| Typecheck | 0.2 | Runs `tsc --noEmit` (if tsconfig exists) |
| Lint | 0.1 | Runs the project's lint command |
| Tests | 0.25 | Runs the project's test suite |
| AI risk review | — | LLM analyzes the diff for security, logic, and quality issues |

**Risk levels:** `low` → `medium` → `high` → `critical`, computed from weighted check failures.

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

### `jam jira`

Connect to Jira (Cloud or on-prem Server/Data Center), browse assigned issues, and start working with AI-generated implementation plans.

```bash
jam jira issues                           # list issues assigned to you
jam jira issues --status "In Progress"    # filter by status
jam jira issues --json                    # JSON output
jam jira view PROJ-123                    # view full issue details
jam jira view PROJ-123 --json             # JSON output
jam jira start PROJ-123                   # fetch issue, create branch, generate plan
jam jira start PROJ-123 --no-branch       # skip branch creation
```

**`jam jira start` flow:**

1. Fetches full issue details (description, subtasks, comments)
2. Creates a git branch from the issue key and summary (e.g. `proj-123-add-user-authentication`)
3. Generates an AI implementation plan: summary, key files, steps, testing, edge cases
4. Suggests the next step: `jam run "Implement PROJ-123: ..."`

**Configuration** (in `.jamrc`):

```json
{
  "jira": {
    "baseUrl": "https://jira.company.com",
    "email": "you@company.com",
    "branchTemplate": "{type}/{key}-{summary}",
    "defaultJql": "project = MYPROJ"
  }
}
```

Set your token: `export JIRA_API_TOKEN=<your-token>` (or `apiToken` in config).

Branch templates support `{key}`, `{type}` (mapped: Bug→fix, Story→feat, Task→chore), and `{summary}`.

---

### `jam cache`

Manage the response cache. Identical prompts return cached results instantly, saving API calls.

```bash
jam cache stats            # show entry count, size, TTL, age range
jam cache stats --json     # structured JSON
jam cache clear            # delete all cached responses
jam cache prune            # remove only expired entries
```

Caching is enabled by default with a 1-hour TTL. Configure in `.jamrc`:

```json
{
  "cacheEnabled": true,
  "cacheTtlSeconds": 3600
}
```

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

### `jam diagram`

Generate Mermaid architecture diagrams from your codebase. Analyzes modules, dependencies, symbols, and cycles using static analysis. AI refinement is optional. [Full documentation](docs/diagram.md)

```bash
jam diagram                              # architecture diagram with AI
jam diagram --no-ai                      # deterministic diagram (no AI needed)
jam diagram --no-ai --type class         # class diagram
jam diagram --no-ai --type deps          # dependency flow
jam diagram --no-ai --focus providers    # focus on a specific module
jam diagram --json                       # raw analysis as JSON
jam diagram --no-ai -o arch.mmd          # save to file
jam diagram --exclude test-utils         # exclude directories
```

**Diagram types:**

| Type | Description |
|------|-------------|
| `architecture` | Top-down module graph with dependency edges and weights (default) |
| `deps` | Left-to-right dependency flow |
| `class` | Class/interface/enum diagram |
| `flow` | Control flow between components |

**Options:**

| Flag | Description |
|------|-------------|
| `--type <type>` | `architecture`, `deps`, `flow`, `class` (default: `architecture`) |
| `-o, --output <file>` | Write Mermaid to file |
| `--json` | Output raw project analysis as JSON |
| `--no-ai` | Deterministic diagram without AI |
| `--focus <module>` | Highlight a specific module |
| `--exclude <dirs>` | Comma-separated directories to exclude |

---

### `jam md2pdf`

Convert Markdown files to PDF using lightweight rendering (no browser dependency). Supports headings, bold/italic, code blocks, lists, tables, links, blockquotes, and horizontal rules.

```bash
jam md2pdf README.md                          # convert to README.pdf
jam md2pdf notes.md -o notes.pdf              # custom output path
jam md2pdf spec.md --style academic           # Times Roman, academic look
jam md2pdf doc.md --style minimal             # clean black & white
jam md2pdf doc.md --title "API Spec"          # custom PDF title
jam md2pdf doc.md --font-size 13              # larger body text
```

**Style presets:**

| Style | Font | Description |
|-------|------|-------------|
| `default` | Helvetica | Blue headings, colored links, modern feel |
| `minimal` | Helvetica | Black & white, clean, no color |
| `academic` | Times Roman | Traditional academic document style |

**Options:**

| Flag | Description |
|------|-------------|
| `-o, --output <path>` | Output file path (default: `<input>.pdf`) |
| `--title <title>` | PDF document title metadata |
| `--style <name>` | `default`, `minimal`, `academic` |
| `--font-size <n>` | Body font size (default: 11) |

---

### `jam plugin`

Manage plugins. Plugins extend Jam with custom commands. [Full documentation](docs/plugins.md)

```bash
jam plugin list              # show installed plugins
jam plugin list --json       # machine-readable output
```

**Creating a plugin:**

```bash
mkdir -p ~/.jam/plugins/my-plugin
# Create jam-plugin.json and index.js (see docs/plugins.md)
```

**Configuration** (in `.jamrc`):

```json
{
  "pluginDirs": ["/path/to/extra/plugins"],
  "enabledPlugins": ["my-plugin"],
  "disabledPlugins": ["unwanted-plugin"]
}
```

---

### `jam doctor`

Run system diagnostics:

```bash
jam doctor
```

Checks:
- Node.js version (>= 20)
- Config file is valid
- Provider connectivity (Ollama reachable)
- ripgrep availability (optional, JS fallback used if absent)
- keytar availability (optional, env vars used if absent)

---

### `jam mcp`

Connect to [MCP (Model Context Protocol)](https://modelcontextprotocol.io) servers and use their tools in `jam ask`, `jam chat`, and `jam run`. Supports per-server governance: enable/disable, groups, tool policies, and allowlists. [Full documentation](docs/mcp.md)

```bash
jam mcp list                # show connected servers, tools, groups, policies
jam mcp list --json         # structured JSON output
```

**Configuration** (in `.jamrc`):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "group": "code",
      "toolPolicy": "auto"
    },
    "postgres": {
      "command": "node",
      "args": ["pg-mcp-server.js"],
      "group": "db",
      "toolPolicy": "ask",
      "allowedTools": ["read_query", "list_tables"]
    }
  },
  "mcpGroups": ["code", "db"]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable this server |
| `group` | string | — | Group tag (e.g. `code`, `jira`, `db`, `browser`) |
| `toolPolicy` | `auto` \| `ask` \| `deny` | `auto` | Tool approval policy for this server |
| `allowedTools` | string[] | — | Only expose these tools (allowlist) |
| `deniedTools` | string[] | — | Hide these tools (denylist) |

---

## Developer Utilities (Zero-LLM)

14 built-in commands that work **without any AI provider**. No API keys, no network calls. Pure algorithmic tools for everyday development. [Full documentation](docs/utilities.md)

### `jam todo`

Scan for TODO/FIXME/HACK/XXX/NOTE/BUG comments with git blame enrichment. [Docs](docs/todo.md)

```bash
jam todo                     # scan and group by type
jam todo --by-author         # group by git author
jam todo --by-age            # sort oldest first
jam todo --type FIXME BUG    # filter specific types
jam todo --json              # machine-readable output
```

### `jam ports`

Show listening ports, identify processes, kill by port. [Docs](docs/ports.md)

```bash
jam ports                    # list all listening ports
jam ports --kill 3000        # kill process on port 3000
jam ports --filter node      # filter by process name
jam ports --json
```

### `jam recent`

Recently modified files grouped by time period. [Docs](docs/recent.md)

```bash
jam recent                   # last 7 days, grouped by today/week/earlier
jam recent --days 30         # last 30 days
jam recent --author "Alice"  # filter by git author
jam recent --json
```

### `jam stats`

Instant codebase health dashboard — LOC, churn, complexity. [Docs](docs/stats.md)

```bash
jam stats                    # full dashboard
jam stats --sort lines       # sort languages by total lines
jam stats --json             # structured output
```

### `jam hash`

Smart file/directory hashing with .gitignore awareness. [Docs](docs/hash.md)

```bash
jam hash src/                # SHA256 of entire directory
jam hash package.json        # single file hash
jam hash --dirty             # hash only modified files
jam hash --check sums.txt    # verify checksums
jam hash --algo md5 --short  # short MD5 hashes
```

### `jam env`

.env file manager — diff, validate, redact. [Docs](docs/env.md)

```bash
jam env                      # list all .env files
jam env --diff               # compare .env vs .env.example
jam env --missing            # find empty variables
jam env --redact             # mask secrets for sharing
jam env --validate           # check format issues
```

### `jam deps`

Import graph analyzer — cycles, orphans, hotspots. [Docs](docs/deps.md)

```bash
jam deps                     # full analysis
jam deps --circular          # circular dependencies only
jam deps --orphans           # files imported by nothing
jam deps --hotspots          # most-imported files
jam deps --src src/          # limit to directory
jam deps --json
```

### `jam dup`

Near-duplicate code detection using token similarity. [Docs](docs/dup.md)

```bash
jam dup                      # scan for duplicates (>80% similar, >6 lines)
jam dup --threshold 0.9      # stricter matching
jam dup --min-lines 10       # larger blocks only
jam dup --glob "*.ts"        # limit to TypeScript
jam dup --json
```

### `jam json`

JSON swiss knife — pretty print, query, diff, flatten. [Docs](docs/json.md)

```bash
jam json data.json                          # pretty print with colors
jam json data.json --query "users[0].name"  # dot-path query
jam json a.json --diff b.json               # deep diff
jam json data.json --flatten                # nested → dot paths
cat data.json | jam json --minify           # minify from stdin
jam json data.json --sort-keys              # sort keys recursively
```

### `jam convert`

Format converter — JSON, YAML, CSV, Base64, URL encode, Hex. [Docs](docs/convert.md)

```bash
jam convert data.json --to yaml             # JSON → YAML
jam convert config.yaml --to json           # YAML → JSON
jam convert data.csv --to json              # CSV → JSON
echo "hello" | jam convert --to base64      # encode
echo "aGVsbG8=" | jam convert --from base64 # decode
echo "hello" | jam convert --to hex         # hex encode
```

### `jam pack`

Package.json analyzer — sizes, unused deps, scripts. [Docs](docs/pack.md)

```bash
jam pack                     # full summary
jam pack --size              # dependency size ranking
jam pack --unused            # detect unused dependencies
jam pack --scripts           # list npm scripts
jam pack --json
```

### `jam http`

HTTP client with auto JSON formatting and timing. [Docs](docs/http.md)

```bash
jam http https://api.example.com/users              # GET (method optional)
jam http POST https://api.example.com/users \
  --body '{"name":"Alice"}'                         # POST with JSON body
jam http GET https://api.example.com \
  --bearer mytoken --verbose --timing               # auth + headers + timing
jam http GET https://api.example.com --output out.json  # save to file
```

### `jam md2pdf`

Convert Markdown to PDF with style presets. [Docs](#jam-md2pdf)

```bash
jam md2pdf README.md                     # convert to PDF
jam md2pdf notes.md --style academic     # Times Roman style
jam md2pdf doc.md -o output.pdf          # custom output path
```

### `jam diagram --no-ai`

Generate architecture diagrams from static analysis. [Docs](docs/diagram.md)

```bash
jam diagram --no-ai                      # architecture diagram
jam diagram --no-ai --type class         # class diagram
jam diagram --no-ai --focus providers    # focus on a module
jam diagram --json                       # raw analysis JSON
```

---

## Plugin System

Extend Jam with custom commands by dropping plugin directories into `~/.jam/plugins/`. [Full documentation](docs/plugins.md)

```bash
# List installed plugins
jam plugin list

# Create a plugin
mkdir -p ~/.jam/plugins/my-tool
# Add jam-plugin.json + index.js (see docs/plugins.md)

# Use it
jam my-command
```

Plugins register Commander.js commands and receive workspace context. Features:
- **User-level** (`~/.jam/plugins/`) and **project-level** (`.jam/plugins/`) plugin directories
- **Manifest-based** — `jam-plugin.json` with name, version, description, command list
- **Enable/disable** via config: `enabledPlugins` / `disabledPlugins` arrays
- **Non-fatal** — broken plugins are skipped; other plugins and built-in commands unaffected
- **Conflict detection** — plugin commands that collide with built-ins are skipped

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

### Full Config Example

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
    "cloud": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-20250514"
    },
    "fast": {
      "provider": "groq",
      "model": "llama-3.1-8b-instant"
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
  "redactPatterns": ["sk-[a-z0-9]+", "Bearer\\s+\\S+"],
  "cacheEnabled": true,
  "cacheTtlSeconds": 3600,
  "commitConvention": {
    "format": "{type}({scope}): {description}",
    "types": ["feat", "fix", "chore", "docs", "refactor", "test"],
    "autoDetect": true
  },
  "jira": {
    "baseUrl": "https://jira.company.com",
    "email": "you@company.com",
    "branchTemplate": "{type}/{key}-{summary}",
    "defaultJql": "project = MYPROJ"
  },
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "group": "code",
      "toolPolicy": "auto"
    }
  },
  "mcpGroups": ["code"],
  "pluginDirs": [],
  "enabledPlugins": [],
  "disabledPlugins": []
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
| `cacheEnabled` | boolean | `true` | Enable response caching |
| `cacheTtlSeconds` | number | `3600` | Cache time-to-live in seconds |
| `pluginDirs` | string[] | `[]` | Additional directories to scan for plugins |
| `enabledPlugins` | string[] | `[]` | Only load these plugins (allowlist) |
| `disabledPlugins` | string[] | `[]` | Never load these plugins (denylist) |

### Profile Fields

| Field | Type | Description |
|-------|------|-------------|
| `provider` | string | Provider name (`ollama`, `openai`, `anthropic`, `groq`, `embedded`) |
| `model` | string | Model ID (e.g. `llama3.2`, `claude-sonnet-4-20250514`, `gpt-4o`) |
| `baseUrl` | string | Provider API base URL |
| `apiKey` | string | API key (prefer keychain or env vars) |
| `temperature` | number | Sampling temperature (0-2) |
| `maxTokens` | number | Max tokens in response |
| `systemPrompt` | string | Default system prompt |

### Commit Convention Fields

| Field | Type | Description |
|-------|------|-------------|
| `format` | string | Message format template with `{type}`, `{scope}`, `{description}`, `{ticket}` placeholders |
| `types` | string[] | Allowed commit types (e.g. `feat`, `fix`, `chore`) |
| `ticketPattern` | string | Regex for ticket IDs (e.g. `"PROJ-\\d+"`) |
| `ticketRequired` | boolean | Whether ticket IDs are mandatory |
| `rules` | string[] | Extra instructions for the AI |
| `autoDetect` | boolean | Auto-detect convention from git history (default: true) |

### Jira Fields

| Field | Type | Description |
|-------|------|-------------|
| `baseUrl` | string | Jira instance URL (Cloud or on-prem) |
| `email` | string | Your Jira email (Cloud) or username (Server) |
| `apiToken` | string | API token (or set `JIRA_API_TOKEN` env var) |
| `defaultJql` | string | Default JQL filter appended to queries |
| `branchTemplate` | string | Branch name template with `{key}`, `{type}`, `{summary}` (default: `{key}-{summary}`) |

### Initialize Config

```bash
# Guided setup — detects providers, creates config + JAM.md
jam init

# Or manual config creation:
jam config init --global   # creates ~/.config/jam/config.json
jam config init            # creates .jam/config.json (repo-level)
```

### Using Profiles

```bash
# Use a specific profile
jam ask "Hello" --profile cloud

# Or auto-detect from model name
jam ask "Hello" --model claude-sonnet-4-20250514    # auto-selects anthropic provider
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `JAM_API_KEY` | API key fallback (if keytar unavailable) |
| `JAM_BASE_URL` | Override provider base URL |
| `OPENAI_API_KEY` | OpenAI API key (used when `provider: openai`) |
| `ANTHROPIC_API_KEY` | Anthropic API key (used when `provider: anthropic`) |
| `GROQ_API_KEY` | Groq API key (used when `provider: groq`) |
| `JIRA_API_TOKEN` | Jira API token for `jam jira` commands |

---

## Embedded Provider — Experimental

> **EXPERIMENTAL** — The embedded provider is functional but quality is limited by small model sizes. For production workloads, use Ollama or OpenAI.

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
npm test                              # Vitest unit tests (358 tests)
npm run test:watch                    # watch mode
npm run test:coverage                 # coverage report
```

### Project Structure

```
src/
├── index.ts           # CLI entry point — command registration (Commander)
├── commands/          # One file per command (ask, chat, run, trace, verify, diagram, md2pdf, …)
├── providers/         # LLM adapters — Ollama, OpenAI, Anthropic, Groq, Embedded
├── analyzers/         # Shared code analysis (import graph, structure, symbols)
├── plugins/           # Plugin loader, manager, types
├── integrations/      # External service clients (Jira)
├── mcp/               # MCP client, transport, manager, types
├── tools/             # Model-callable tools + registry + permission enforcement
├── config/            # Zod schema, cosmiconfig loader, built-in defaults
├── storage/           # Chat sessions + response cache (file-based)
├── ui/                # Ink/React TUI (chat REPL) + Markdown/streaming renderer
└── utils/             # Shared: streaming, call-graph, agent loop, tokens, secrets, logger
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

3. (Optional) Add auto-detection in `inferProviderFromModel()`:

```typescript
if (m.startsWith('my-model-')) return 'myprovider';
```

4. Use: `jam ask "Hello" --provider myprovider`

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
- **Tests colocated with source** — `foo.ts` → `foo.test.ts`, using Vitest (358 tests across 29 files)
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

- [x] Ollama provider (default)
- [x] OpenAI provider
- [x] Anthropic Claude provider
- [x] Groq provider
- [x] Embedded provider (experimental)
- [x] Provider auto-detection from model name
- [x] Structured plan-then-execute agent (`jam run`)
- [x] Smart commit conventions (auto-detect + config)
- [x] Jira integration (`jam jira`)
- [x] Verification pipeline (`jam verify`)
- [x] Call graph tracing (`jam trace`)
- [x] Response caching (`jam cache`)
- [x] Actionable error messages with hints
- [x] MCP (Model Context Protocol) support with governance
- [x] 14 zero-LLM developer utilities
- [x] Plugin system for custom commands
- [x] Architecture diagram generation (`jam diagram`)
- [x] Markdown to PDF conversion (`jam md2pdf`)
- [ ] Token usage tracking and budgets
- [ ] Embeddings & vector search
- [ ] Web UI companion

---

## Probable Enhancements

> Ideas and directions under consideration. These range from quick wins to deep architectural changes. Contributions, RFCs, and discussion on any of these are welcome.

### Skills

Skills are named, composable mini-agents — each with a focused system prompt, a curated tool subset, and a defined output contract.

- **Built-in skills** — `refactor`, `test-writer`, `documenter`, `security-audit`
- **User-defined skills** — `.jam/skills/` directory with YAML/JSON skill definitions
- **Composable** — skills can call other skills (e.g., `refactor` invokes `test-writer` to verify changes)

### Sub-Agents & Task Decomposition

`jam run` uses a structured plan-then-execute loop. The next evolution is true sub-agent decomposition — routing specialist child agents for independent sub-tasks.

- **Planner agent** — breaks a complex instruction into an ordered DAG of sub-tasks
- **Parallel sub-agents** — independent sub-tasks execute concurrently
- **Fail-and-retry isolation** — a failed sub-agent can be retried without restarting the entire task

### Embeddings & Vector Search

The current past-session search uses keyword overlap (Jaccard scoring). Optional local embeddings would enable true semantic search.

- **Local embedding model** — use Ollama's embedding endpoint so nothing leaves your machine
- **Semantic code search** — `jam search "authentication flow"` returns semantically relevant code
- **RAG pipeline** — retrieve relevant code chunks before prompting

### Cost & Token Tracking

`TokenUsage` is already captured per request but not aggregated or displayed.

- **Session cost estimation** — estimate cost based on provider pricing
- **Budget limits** — `maxCostPerSession`, `maxCostPerDay` in config
- **Usage dashboard** — `jam usage` command showing tokens consumed over time

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

**Made with care by [Sunil Prakash](https://github.com/sunilp)**

If you find Jam useful, consider giving it a star on GitHub — it helps others discover the project!

</div>
