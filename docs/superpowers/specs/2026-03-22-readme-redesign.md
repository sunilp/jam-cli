# README Redesign — Spec

## Goal

Rewrite the jam-cli README from a 1,566-line reference manual to a ~400-line engagement-optimized landing page. 3-second wow factor. Cookbook-style examples. Technical authority with personality.

## Scope

- Rewrite `README.md` in jam-cli repo
- Update website at jam.sunilprakash.com with content moved from README (separate task, not this spec)
- Create a terminal recording GIF for the hero visual (separate task)

## Design Principles

1. **3-second rule** — someone landing on the repo should know what Jam does and want to try it within 3 seconds
2. **Show, don't explain** — code examples over prose
3. **Technical authority with personality** — facts build trust, playful commands build affection
4. **Sell in README, teach on website** — the README is a pitch document, not a manual

## Tone

Lead with facts. Let personality peek through in examples.

- Tagline: confident, factual, no hype words
- Examples: show real commands with inline comments that have personality
- No exclamation marks. No "amazing" or "powerful." Let the output speak.

## Structure (~400 lines)

### 1. Header (lines 1-20)

```markdown
<div align="center">

# jam

**Cross-language code intelligence from your terminal.**

Trace call graphs across Java, SQL, Python, and TypeScript. Impact analysis.
AI-powered insights. Agentic task execution. Zero vendor lock-in.

[![CI](badge)](link) [![npm](badge)](link) [![License: MIT](badge)](link)

[Docs](https://jam.sunilprakash.com) · [Install](#install) · [VSCode Extension](marketplace-link)

</div>
```

Key changes from current:
- Drop the ASCII art logo (use a clean SVG or just the `# jam` heading — faster to render, cleaner on mobile)
- Cut badges from 7 to 3 (CI, npm, license)
- Add direct links to docs site, install, and VSCode extension
- Two-line value prop replaces the long subtitle

### 2. Hero Visual (lines 21-25)

```markdown
<div align="center">
  <img src="docs/assets/demo.gif" alt="jam trace with impact analysis" width="720">
</div>
```

An animated terminal GIF showing `jam trace updateBalance --impact` on a multi-language codebase. Shows: symbol found → callers listed (Java + SQL) → column dependents → risk assessment. ~8 seconds, dark terminal theme.

For now (until GIF is created), use a static code block showing representative output:

```
$ jam trace updateBalance --impact

Impact Analysis for updateBalance
═══════════════════════════════════

Direct callers:
  → PaymentService.processRefund() [Java]
  → BATCH_RECONCILE [SQL]

Column dependents:
  → VIEW v_customer_summary (reads customer.balance)
  → PROC_MONTHLY_STATEMENT (reads customer.balance)

Risk: HIGH — 2 callers across 2 languages, 2 column dependents
```

### 3. Feature Bullets (lines 26-45)

Emoji-prefixed scannable list. 12 items max. Grouped by capability, not by command name.

```markdown
## What Jam Does

- 🔍 **Call graph tracing** — trace any symbol's callers, callees, and upstream chain across languages
- 💥 **Impact analysis** — "if I change this, what breaks?" with column-level dependency tracking
- 🤖 **Agentic execution** — `jam go` (interactive) and `jam run` (one-shot) decompose tasks into parallel subtasks
- 💬 **AI chat & ask** — streaming responses, multi-turn sessions, stdin/pipe support
- 🩹 **Patch workflow** — generate diffs, validate, preview, apply with confirmation
- 📊 **Code intelligence** — explain files, search code, review diffs, generate diagrams
- 🔧 **Git toolkit** — `wtf` explains state, `undo` reverses mistakes, `standup` shows your work
- ✅ **Verification** — scan for secrets, lint, type-check before you commit
- 🧰 **19 zero-LLM utilities** — `ports`, `stats`, `deps`, `todo`, `hash`, `json`, `env`, and more
- 🔌 **Any provider** — Ollama, OpenAI, Anthropic, Groq, GitHub Copilot — or bring your own
- 🏠 **Local-first** — your code never leaves your machine unless you choose a remote provider
- 🔗 **MCP + plugins** — connect to Model Context Protocol servers, drop in custom commands
```

### 4. Install (lines 46-65)

```markdown
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
```

### 5. Cookbook (lines 66-200)

One real example per category. Show command + representative output (truncated). Comments add personality.

```markdown
## Cookbook

### Ask & Chat

```bash
jam ask "explain the builder pattern in Go"

# pipe anything
cat schema.sql | jam ask "what tables have no foreign keys?"

# interactive chat with history
jam chat
```

### Agent Engine

```bash
# interactive agent console
jam go
> add retry logic to the HTTP client with exponential backoff

# one-shot autonomous task
jam run "add input validation to all API endpoints" --yes
```

### Code Intelligence

```bash
# trace a function's call graph across languages
jam trace updateBalance --impact

# explain any file
jam explain src/auth/middleware.ts

# search with AI understanding
jam search "where is the rate limiter configured?"
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
jam verify           # pre-commit checks (secrets, lint, types)
jam ports            # what's listening on which port
jam diagram          # generate architecture diagram from code
```

### Patch & Review

```bash
jam diff             # AI-powered diff summary
jam review           # code review with risk assessment
jam patch "add error handling to the database module"
jam commit           # auto-generate commit message matching your convention
```
```

### 6. VSCode Extension (lines 201-215)

```markdown
## VSCode Extension

[Install from Marketplace](https://marketplace.visualstudio.com/items?itemName=sunilp.jam-cli-vscode)

- All commands available in the Command Palette
- `@jam` chat participant in GitHub Copilot Chat
- TODO tree in the sidebar
- Copilot auto-detected as AI provider — no configuration needed
```

### 7. Configuration (lines 216-250) — compact

```markdown
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

[Full configuration docs →](https://jam.sunilprakash.com/docs/configuration)
```

### 8. Footer (lines 251-270)

```markdown
## Links

- 📖 [Documentation](https://jam.sunilprakash.com)
- 🧩 [VSCode Extension](https://marketplace.visualstudio.com/items?itemName=sunilp.jam-cli-vscode)
- 🍺 [Homebrew Tap](https://github.com/sunilp/homebrew-tap)
- 🐛 [Issues](https://github.com/sunilp/jam-cli/issues)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome.

## License

MIT
```

## What Gets Removed (moved to website)

- "What's New in v0.9.0" block → website changelog page
- "Why Jam?" prose section → condensed into feature bullets
- "Design Philosophy" section → website about page
- "Who Is Jam For?" table → website
- Full command reference (all 30+ commands with examples) → website docs
- Enterprise configuration (proxy, TLS, timeouts) → website
- MCP deep dive → website
- Plugin system details → website
- Architecture section → CONTRIBUTING.md
- Provider comparison table → website
- Shell completions setup → website
- Embedded inference details → website

## Content for Website (to be added later)

The website should gain these pages from the removed README content:
- `/docs/commands` — full command reference
- `/docs/configuration` — profiles, providers, proxy, TLS, MCP, plugins
- `/docs/architecture` — for contributors
- `/changelog` — version history with feature highlights
