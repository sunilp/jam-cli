# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `jam agent` — coding agent harness. Completion is decided by a deterministic
  verifier rather than the model: a session reports `COMPLETED_VERIFIED` only
  when every declared verification requirement ran and passed, and
  `COMPLETED_UNVERIFIED` when none were declared. Every tool call is mediated by
  a policy reference monitor and recorded in an append-only session journal.
  Headless mode via `--json` with documented exit codes. **Limitation:** a
  requirement's command is frozen as text at session start, not what it
  resolves to, so a model that rewrites what that text resolves to (for
  example `package.json`'s `scripts.test`) can still make a verified command
  report success — the ordinary reward-hacking failure mode, not an exotic
  attack.

## [0.12.0] - 2026-05-11

### Changed
- **New positioning:** jam is now the cross-language code intelligence CLI for polyglot codebases. Lead use case: trace, impact, and diagram analysis across Java, SQL, Python, TypeScript, and Kotlin (Phase 3).
- README rewritten around the new positioning. npm description and keywords updated.

### Added
- `jam impact <symbol>` — shortcut for `jam trace <symbol> --impact`.
- Migration pointer: running an archived command (`jam ask`, `jam run`, etc.) prints a clear pointer to the [archive/ai-suite](https://github.com/sunilp/jam-cli/tree/archive/ai-suite) branch.
- Regression guards: `trace-smoke.test.ts` and `keep-set-isolation.test.ts` prevent future re-coupling of the trace path to archive-bound modules.

### Removed
The following commands and their underlying modules were archived to the [`archive/ai-suite`](https://github.com/sunilp/jam-cli/tree/archive/ai-suite) branch. None of the code is lost — recover any file with `git checkout archive/ai-suite -- <path>`.

- `jam ask`, `jam chat`, `jam run`, `jam go` — AI assistant features (use Claude Code, Cursor, or Aider instead).
- `jam explain`, `jam review`, `jam verify`, `jam patch`, `jam commit`, `jam diff` — AI-augmented developer features.
- `jam jira issues/start/view` — Jira integration.
- `jam md2pdf` — Markdown-to-PDF.
- `jam vibes` — hidden fortune-cookie easter egg.
- `jam intel scan/status/query/impact/diagram/explore` — older code-intelligence subsystem, fully superseded by `jam trace` (Trace v2, tree-sitter + SQLite).

### Internal
- Archived `src/agent/`, `src/tools/`, `src/intel/`, `src/integrations/` directories.
- Archived `src/utils/{agent,memory,critic,past-sessions,index-builder,cache}.ts`.
- Removed `updateContextWithUsage` from `src/utils/context.ts` (its only caller was archived).
- `src/personality/soul.ts` retained, parked for a future Phase 4+ AI revival.

### Why
After three months of building generic AI-assistant features, jam had 1 GitHub star and ~4 npm downloads/day. The space is owned by Claude Code, Cursor, Aider, and friends. Cross-language call graph tracing with column-level SQL impact analysis is the one thing none of them do — and that is now jam's only job.

## [0.3.0] - 2026-02-23

### Added
- **Structured plan-then-execute reasoning** for `jam run`: the agent now generates a typed `ExecutionPlan` (ordered steps with success criteria) before acting, replacing the free-text ReAct loop
- **Read-before-write gate**: write tools are automatically blocked until the target file has been read, preventing silent overwrites of unread files
- **Post-write shrinkage guard**: if a `write_file` call produces a file suspiciously smaller than the original, the file is auto-restored from git and the model is redirected
- **`--yes` flag** on `jam run` for non-interactive auto-approval of all write operations
- `StepVerifier` to validate each plan step before execution
- Working memory + tool-result caching for the agent loop
- Critic evaluation and correction pass after the tool loop completes
- Past-session search and symbol index builder for richer context injection

### Fixed
- `--provider` CLI flag no longer inherits `baseUrl` from the active profile when switching providers (e.g. `--provider openai` no longer accidentally hits `localhost:11434`)
- Removed unnecessary type assertions in `run.ts`
- Removed unnecessary escape characters in `agent.ts`

## [0.2.0] - 2026-02-23

### Added
- **Embedded provider** (`--provider embedded`): run SmolLM2-1.7B fully in-process via `node-llama-cpp` — no external server needed
- Default embedded model upgraded to `smollm2-1.7b-instruct-q4_k_m` (1.7B, q4_k_m) with 8192-token context window
- One-time model download from GitHub releases with progress reporting
- `jam commit --provider embedded` — commit message generation works offline with diff-stat fallback for large diffs
- `supportsTools` / `contextWindow` fields on `ProviderInfo` for capability-aware routing
- Lean system prompt path for small models that cannot follow tool-call JSON schemas

### Fixed
- Lint errors in embedded provider download stream handler (`Unsafe array destructuring` / `Unsafe member access`)

## [0.1.2] - 2026

### Added
- Initial release of Jam CLI
- `jam ask` — one-shot AI questions with streaming output
- `jam chat` — interactive multi-turn chat REPL (Ink/React TUI)
- `jam explain` — AI-powered code explanation
- `jam search` — codebase search with ripgrep (JS fallback)
- `jam diff` — git diff review with AI analysis
- `jam patch` — AI-generated unified diffs with validation and apply
- `jam run` — agentic task workflow with tool-calling loop
- `jam auth` — provider authentication management
- `jam config` — configuration management (init, show)
- `jam models list` — list available models from provider
- `jam history` — chat session history (list, show)
- `jam completion install` — shell completion for bash/zsh
- `jam doctor` — system diagnostics and health checks
- Ollama provider with NDJSON streaming
- Pluggable provider architecture (adapter pattern)
- Layered configuration (global → repo → CLI flags)
- Named profiles for multiple provider/model configs
- Secure secrets via OS keychain (keytar) with env var fallback
- Model-callable tools: read_file, list_dir, search_text, git_status, git_diff, write_file, apply_patch
- Tool permission enforcement (ask_every_time, allowlist, never)
- Chat session persistence (JSON files)
- Log redaction for sensitive patterns
- Markdown rendering in terminal (marked + marked-terminal)

## [0.1.0] - 2026

### Added
- Initial project setup
- Core CLI framework with Commander.js
- Ollama integration
- Basic tool system
- Configuration with Zod schema validation
