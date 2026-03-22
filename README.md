<div align="center">

# jam

**Cross-language code intelligence from your terminal.**

Trace call graphs across Java, SQL, Python, and TypeScript. Impact analysis.
AI-powered agentic execution. 978 tests. Zero vendor lock-in.

[![CI](https://github.com/sunilp/jam-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/sunilp/jam-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@sunilp-org/jam-cli.svg)](https://www.npmjs.com/package/@sunilp-org/jam-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Docs](https://jam.sunilprakash.com) · [Install](#install) · [VSCode Extension](https://marketplace.visualstudio.com/items?itemName=sunilp.jam-cli-vscode)

</div>

---

```
$ jam trace updateBalance --impact

Impact Analysis for updateBalance
═══════════════════════════════════

Direct callers:
  → PaymentService.processRefund() [Java] (line 142)
  → BATCH_NIGHTLY_RECONCILE [SQL] (line 34)

Column dependents:
  → VIEW v_customer_summary (reads customer.balance)
  → PROC_MONTHLY_STATEMENT (reads customer.balance)

Trigger chain:
  → TRG_CUSTOMER_AUDIT fires on UPDATE customer

Risk: HIGH — 2 callers across 2 languages, 2 column dependents, 1 trigger
```

---

## What Jam Does

- 🔍 **Call graph tracing** — trace any symbol's callers, callees, and upstream chain across languages
- 💥 **Impact analysis** — "if I change this, what breaks?" with column-level SQL dependency tracking
- 🤖 **Agentic execution** — `jam go` (interactive) and `jam run` (one-shot) decompose tasks into parallel subtasks
- 💬 **AI chat & ask** — streaming responses, multi-turn sessions, stdin/pipe support
- 🩹 **Patch workflow** — generate diffs, validate, preview, apply with confirmation
- 📊 **Code intelligence** — explain files, search code, review diffs, generate Mermaid diagrams
- 🔧 **Git toolkit** — `wtf` explains state, `undo` reverses mistakes, `standup` shows your work
- ✅ **Verification** — scan for secrets, lint, type-check before you commit
- 🧰 **19 zero-LLM utilities** — `ports`, `stats`, `deps`, `todo`, `hash`, `json`, `env`, and more
- 🔌 **Any provider** — Ollama, OpenAI, Anthropic, Groq, GitHub Copilot — or bring your own
- 🏠 **Local-first** — your code never leaves your machine unless you choose a remote provider
- 🔗 **MCP + plugins** — connect to Model Context Protocol servers, drop in custom commands

---

## Install

```bash
# npm
npm install -g @sunilp-org/jam-cli

# Homebrew
brew tap sunilp/tap && brew install jam-cli

# Try without installing
npx @sunilp-org/jam-cli doctor
```

Jam auto-detects the best available AI provider:

| Priority | Provider | Setup |
|----------|----------|-------|
| 1 | **GitHub Copilot** | VSCode extension or Copilot CLI installed |
| 2 | **Anthropic** | `export ANTHROPIC_API_KEY=sk-ant-...` |
| 3 | **OpenAI** | `export OPENAI_API_KEY=sk-...` |
| 4 | **Ollama** (default) | `ollama serve` + `ollama pull llama3.2` |

```bash
jam doctor    # verify everything works
```

---

## Cookbook

### Ask & Chat

```bash
jam ask "explain the builder pattern in Go"

# pipe anything
cat schema.sql | jam ask "what tables have no foreign keys?"
git log --since="1 week" -p | jam ask "summarize this week's changes"

# interactive chat with history
jam chat
```

### Agent Engine

```bash
# interactive agent console — reads, writes, runs commands
jam go
jam> add retry logic to the HTTP client with exponential backoff

# one-shot autonomous task
jam run "add input validation to all API endpoints" --yes

# fully autonomous with parallel workers
jam run "refactor auth module into separate files" --auto --workers 4
```

### Code Intelligence

```bash
# trace a function's call graph
jam trace createProvider
jam trace updateBalance --impact       # what breaks if this changes?
jam trace handleRequest --mermaid      # output as Mermaid diagram
jam trace PROC_PAYMENT --depth 8       # deeper upstream chain

# explain any file
jam explain src/auth/middleware.ts

# search with AI understanding
jam search "where is the rate limiter configured?"

# generate architecture diagram from code
jam diagram
```

### Git Toolkit

```bash
jam git wtf          # "3 files staged, 2 conflicts, 1 stash. Here's what happened..."
jam git undo         # undo last commit, last stash, or last merge
jam git standup      # your commits from the last 3 days
jam git cleanup      # preview and delete merged branches
jam git oops         # fix common mistakes (wrong branch, bad commit message)
```

### Dev Utilities (zero LLM)

```bash
jam stats            # LOC, languages, complexity hotspots
jam deps             # import dependency graph
jam todo             # find all TODO/FIXME/HACK comments
jam verify           # pre-commit checks: secrets, lint, types
jam ports            # what's listening on which port
jam env              # environment variable diff between shells
jam hash <file>      # MD5/SHA1/SHA256 of any file
jam json <file>      # validate, format, query JSON
jam recent           # recently modified files
jam convert 5kg lb   # unit conversions
jam http GET /users  # quick HTTP requests
jam pack             # analyze npm/pip/cargo package size
```

### Patch & Review

```bash
# AI-powered diff summary
jam diff

# code review with risk assessment
jam review

# generate and apply a patch
jam patch "add error handling to the database module"

# auto-generate commit message matching your project's convention
jam commit
```

---

## VSCode Extension

[Install from Marketplace](https://marketplace.visualstudio.com/items?itemName=sunilp.jam-cli-vscode)

- All commands in the Command Palette
- `@jam` chat participant in GitHub Copilot Chat
- TODO tree in the sidebar with click-to-navigate
- Copilot auto-detected as AI provider — zero configuration
- Keeps jam-cli updated automatically

---

## Configuration

```bash
jam init              # interactive setup wizard
jam config show       # show resolved config
```

```json
// .jamrc (per-project)
{
  "defaultProfile": "work",
  "profiles": {
    "work": { "provider": "anthropic", "model": "claude-sonnet-4-20250514" },
    "local": { "provider": "ollama", "model": "llama3.2" }
  }
}
```

```bash
jam ask "hello" --profile work     # use Anthropic
jam ask "hello" --profile local    # use Ollama
```

Supports HTTP proxy (`HTTP_PROXY`), custom CA certificates (`tlsCaPath`), configurable timeouts, MCP servers, and plugin loading. [Full configuration docs →](https://jam.sunilprakash.com)

---

## Links

- 📖 [Documentation](https://jam.sunilprakash.com)
- 🧩 [VSCode Extension](https://marketplace.visualstudio.com/items?itemName=sunilp.jam-cli-vscode)
- 🍺 [Homebrew Tap](https://github.com/sunilp/homebrew-tap)
- 🐛 [Issues](https://github.com/sunilp/jam-cli/issues)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome.

## License

MIT
