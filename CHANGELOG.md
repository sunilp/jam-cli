# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
