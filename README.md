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
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org)

Ask questions • Explain code • Review diffs • Generate patches • Run agentic tasks

*All from your command line, powered by any Ollama-hosted model.*

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
| 🤖 | **Tool-calling agent** | `jam run` gives the model access to local tools (read, search, diff, apply) |
| 🔌 | **Pluggable providers** | Ollama by default; adapter pattern for adding any LLM |
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

### Prerequisites

- **Node.js 20+**
- **[Ollama](https://ollama.ai)** running locally (`ollama serve`)
- A pulled model: `ollama pull llama3.2`

### Install

```bash
# Global install (once published to npm)
npm install -g jam-cli

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
| `--no-color` | Strip ANSI colors from output |

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

Agentic task workflow — the model can call tools in a loop to accomplish a goal.

```bash
jam run "Find all TODO comments and summarize them"
jam run "Check git status and explain what's changed"
jam run "Read src/config.ts and identify any security issues"
```

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

Write tools require confirmation unless `toolPolicy` is set to `allowlist` in config.

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
1. CLI flags
2. .jam/config.json  or  .jamrc  (repo-level)
3. ~/.config/jam/config.json     (user-level)
4. Built-in defaults
```

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
| `toolPolicy` | `ask_every_time` \| `allowlist` \| `never` | `ask_every_time` | How write tools require confirmation |
| `toolAllowlist` | string[] | `[]` | Tools that never prompt (when policy is `allowlist`) |
| `historyEnabled` | boolean | `true` | Save chat sessions to disk |
| `logLevel` | `silent` \| `error` \| `warn` \| `info` \| `debug` | `warn` | Log verbosity |
| `redactPatterns` | string[] | `[]` | Regex patterns redacted from logs |

### Profile Fields

| Field | Type | Description |
|-------|------|-------------|
| `provider` | string | Provider name (`ollama`) |
| `model` | string | Model ID (e.g. `llama3.2`, `codellama`) |
| `baseUrl` | string | Provider API base URL |
| `apiKey` | string | API key (prefer keychain or env vars) |
| `temperature` | number | Sampling temperature (0–2) |
| `maxTokens` | number | Max tokens in response |
| `systemPrompt` | string | Default system prompt |

### Initialize Config

```bash
# Repo-level (committed to version control)
jam config init

# User-level (applies everywhere)
jam config init --global
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
├── index.ts              # CLI entry point (commander, lazy imports)
├── commands/             # One file per command
│   ├── ask.ts            # jam ask
│   ├── chat.ts           # jam chat
│   ├── run.ts            # jam run (agentic loop)
│   ├── explain.ts        # jam explain
│   ├── search.ts         # jam search
│   ├── diff.ts           # jam diff
│   ├── patch.ts          # jam patch
│   ├── auth.ts           # jam auth
│   ├── config.ts         # jam config
│   ├── models.ts         # jam models
│   ├── history.ts        # jam history
│   ├── completion.ts     # jam completion
│   └── doctor.ts         # jam doctor
├── providers/            # LLM adapter layer
│   ├── base.ts           # ProviderAdapter interface
│   ├── ollama.ts         # Ollama adapter (NDJSON streaming)
│   └── factory.ts        # createProvider()
├── tools/                # Model-callable local tools
│   ├── types.ts          # ToolDefinition, ToolResult interfaces
│   ├── registry.ts       # ToolRegistry + permission enforcement
│   ├── read_file.ts
│   ├── list_dir.ts
│   ├── search_text.ts
│   ├── git_diff.ts
│   ├── git_status.ts
│   ├── apply_patch.ts
│   └── write_file.ts
├── config/               # Config loading and schema
│   ├── schema.ts         # Zod schema
│   ├── defaults.ts       # Built-in defaults
│   └── loader.ts         # cosmiconfig + deep merge
├── storage/
│   └── history.ts        # Chat session persistence (JSON files)
├── ui/
│   ├── chat.tsx          # Ink chat REPL (React TUI)
│   └── renderer.ts       # Markdown + streaming renderer
└── utils/
    ├── errors.ts         # JamError class
    ├── stream.ts         # withRetry, collectStream
    ├── logger.ts         # Logger (stderr, redaction)
    ├── secrets.ts        # keytar + env fallback
    └── workspace.ts      # Git root detection
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

- [ ] OpenAI / Azure OpenAI provider
- [ ] Anthropic Claude provider
- [ ] Groq provider
- [ ] `jam commit` — AI-generated commit messages
- [ ] `jam review` — PR review workflow
- [ ] Plugin system for custom tools
- [ ] Token usage tracking and budgets
- [ ] Web UI companion

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
