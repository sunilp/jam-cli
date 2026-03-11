# Jam Utilities — Zero-LLM Developer Tools

Jam includes 14 built-in utility commands that work **without any AI provider**. No Ollama, no API keys, no network calls. They are pure algorithmic tools that run instantly on your local codebase.

Think of them as a developer swiss army knife built into your CLI.

## Quick Reference

| Command | What it does |
|---------|-------------|
| [`jam todo`](todo.md) | Scan for TODO/FIXME/HACK comments with git blame |
| [`jam ports`](ports.md) | Show listening ports, kill by port |
| [`jam recent`](recent.md) | Recently modified files grouped by time |
| [`jam stats`](stats.md) | LOC by language, churn, complexity hotspots |
| [`jam hash`](hash.md) | File/directory hashing with .gitignore awareness |
| [`jam env`](env.md) | .env file manager: diff, validate, redact |
| [`jam deps`](deps.md) | Import graph: cycles, orphans, hotspots |
| [`jam dup`](dup.md) | Near-duplicate code detection |
| [`jam json`](json.md) | Pretty print, query, diff, flatten JSON |
| [`jam convert`](convert.md) | Convert between JSON, YAML, CSV, base64, URL, hex |
| [`jam pack`](pack.md) | Package.json analyzer: sizes, unused deps |
| [`jam http`](http.md) | HTTP client with auto JSON formatting |
| [`jam md2pdf`](#jam-md2pdf) | Convert Markdown files to styled PDFs |
| [`jam diagram --no-ai`](diagram.md) | Generate Mermaid architecture diagrams from code |

## Common Patterns

### JSON output for scripting

Every utility command supports `--json` for machine-readable output:

```bash
jam todo --json | jq '.[] | select(.type == "FIXME")'
jam stats --json | jq '.summary.code'
jam ports --json | jq '.[].port'
jam deps --json | jq '.cycles'
```

### Piping between commands

```bash
# Find TODOs by the most active contributors
jam recent --json | jq -r '.[].authors[]' | sort | uniq -c | sort -rn

# Hash only recently changed files
jam recent --json | jq -r '.[].file' | xargs jam hash

# Convert API response from JSON to YAML
jam http GET https://api.example.com/config | jam convert --to yaml
```

### CI/CD integration

```bash
# Fail CI if there are circular dependencies
jam deps --circular --json | jq -e '.cycles | length == 0' || exit 1

# Check file integrity
jam hash src/ --short > checksums.txt
jam hash --check checksums.txt

# Validate .env before deploy
jam env --validate || exit 1

# Fail if code duplication exceeds threshold
jam dup --json | jq -e 'length < 10' || echo "Too much duplication"
```

## Design Principles

1. **No network calls** — Everything runs locally against your filesystem and git history
2. **Fast** — Regex-based parsing, no AST compilation, streams large codebases
3. **Git-aware** — Uses `git ls-files` for file discovery, respects `.gitignore`
4. **Composable** — `--json` output works with jq, pipes, and other Unix tools
5. **Zero configuration** — Sensible defaults, no setup required
