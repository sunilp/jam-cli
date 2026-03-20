# Jam Agent Engine — Design Spec

**Date:** 2026-03-20
**Status:** Draft
**Scope:** `jam go` (interactive agent) + `jam run` (one-shot agent) sharing a new agent engine

---

## 1. Problem

Jam CLI has read-only agentic capabilities (`jam ask`) and basic write tools (`jam run`, `jam go`), but lacks the autonomous multi-step coding capabilities that modern AI CLI tools offer: file editing with context awareness, shell execution within agentic loops, multimodal input, parallel task execution, and workspace convention understanding.

## 2. Goals

- **`jam go`**: Interactive console for continuous agentic work — user types tasks, agent executes, user gives feedback mid-flight
- **`jam run`**: One-shot autonomous execution — single prompt, runs to completion, exits. Suitable for CI/scripts
- Both commands share the same agent engine with full capabilities:
  - Multi-step task decomposition with parallel worker execution
  - File editing with workspace convention awareness
  - Shell execution with tiered permissions and OS-level sandboxing
  - Image input for screenshots, diagrams, mockups
  - Intelligent workspace profiling cached for future use

## 3. Non-Goals (v1)

- Audio/video input (future)
- Auto-screenshot of running apps (future)
- Container-based sandboxing (future)
- Windows OS-level sandboxing (permissions-only for v1, sandbox in v2)
- Plugin API for custom agent capabilities (future)

---

## 4. Architecture

### 4.1 Module Layout

```
src/agent/
  orchestrator.ts      — task decomposition, dispatch, merge, conflict resolution
  worker.ts            — single-subtask execution loop
  planner.ts           — multi-step plan generation with dependency graph
  sandbox.ts           — OS-level command sandboxing (macOS/Linux)
  permissions.ts       — tiered permission system (safe/moderate/dangerous)
  multimodal.ts        — image input parsing, encoding, provider routing
  file-lock.ts         — hybrid file ownership + request-grant protocol
  workspace-intel.ts   — convention detection, style analysis, cached profiling
  types.ts             — shared types
  index.ts             — barrel export
```

Entry points:
- `src/commands/go.ts` — interactive console, calls orchestrator per user task
- `src/commands/run.ts` — one-shot, single orchestrator invocation then exit

Shared infrastructure (reused, not duplicated):
- `src/tools/` — ToolRegistry, all read+write tools, safePath, policies
- `src/utils/agent.ts` — planning utils, step verification, tool call tracking
- `src/utils/memory.ts` — WorkingMemory, context compaction, scratchpad
- `src/utils/critic.ts` — answer quality evaluation
- `src/providers/` — ProviderAdapter (extended for multimodal)
- `src/mcp/` — McpManager shared across workers
- `src/config/` — JamConfigSchema (extended with agent section)

### 4.2 Data Flow

```
User prompt + images
       |
  Workspace Intelligence (cached profile)
       |
  Orchestrator
       |
  Planner (LLM call -> TaskPlan with dependency graph)
       |
  Orchestrator dispatches workers (topological order)
       |
  +----------+-----------+
  Worker A   Worker B    Worker C   (parallel if independent)
  +----------+-----------+
       |
  Orchestrator merges results
       |
  Conflict resolution (auto or user-prompted)
       |
  Validation (tests, lint, type-check)
       |
  Final summary + applied changes
```

### 4.3 Concurrency Model

Parallel workers need safe access to the provider and MCP servers.

**Provider access:** Workers share a single `ProviderAdapter` instance through a request semaphore. The semaphore limits concurrent `chatWithTools()` calls to avoid API rate limits:

```typescript
interface ProviderPool {
  acquire(): Promise<ProviderLease>;   // blocks if at concurrency limit
  release(lease: ProviderLease): void;
  concurrencyLimit: number;            // default: 3 (matches maxWorkers)
}
```

- Token usage is aggregated: each `WorkerResult` includes `tokensUsed`, orchestrator sums them.
- On rate-limit (429/retry-after): semaphore pauses all workers until cooldown expires.
- Provider adapters with internal state (e.g., `CopilotAdapter.ensureBackend()`) are protected by the semaphore — only one initialization can run at a time.

**MCP access:** MCP servers are stdio-based child processes. Concurrent tool calls are serialized per-server via an internal queue in `McpManager`. Multiple servers can be called in parallel.

### 4.4 Cancellation Protocol

Workers accept an `AbortSignal` from the orchestrator:

```typescript
interface WorkerOptions {
  subtask: Subtask;
  context: SubtaskContext;
  signal: AbortSignal;    // orchestrator can abort at any time
}
```

Cancellation triggers:
- User presses Ctrl+C or types "stop" in `jam go` interactive mode
- Orchestrator detects a critical dependency failed (no point continuing)
- Worker exceeds its round budget (see Section 6.6)
- Global timeout exceeded

On cancellation, workers:
1. Stop after the current tool call completes (no mid-tool abort)
2. Roll back any uncommitted file writes from the current round
3. Return a `WorkerResult` with `status: 'cancelled'` and a summary of partial work

### 4.5 Command Comparison

| Aspect | `jam go` | `jam run` |
|--------|----------|-----------|
| Mode | Interactive console | One-shot, exits when done |
| Input | Continuous — type tasks, give feedback | Single prompt (arg, stdin, `--file`) |
| Default autonomy | Supervised (user is present) | Semi-autonomous (user isn't watching) |
| `--auto` | Available, promotes to fully autonomous | Primary usage mode |
| Use case | Dev at keyboard | CI/CD, scripts, automation |
| Session | Persistent, multi-task | Single task |

---

## 5. Orchestrator

### 5.1 Lifecycle

```
1. PLAN     — LLM generates TaskPlan from prompt + WorkspaceProfile
2. ASSIGN   — Assign file ownership per subtask from plan
3. DISPATCH — Launch workers (parallel when dependency graph allows)
4. MONITOR  — Track progress, handle file-lock requests
5. MERGE    — Collect WorkerResults, resolve file conflicts
6. VERIFY   — Run validation commands (tests, lint, type-check)
7. REPORT   — Summary of changes to user
```

### 5.2 TaskPlan

```typescript
interface TaskPlan {
  goal: string;
  subtasks: Subtask[];
  dependencyGraph: Map<string, string[]>;  // subtaskId -> [blockedBy]
}

interface Subtask {
  id: string;
  description: string;
  files: FileOwnership[];
  estimatedRounds: number;
  validationCommand?: string;           // e.g. "npm test -- --grep user"
}

interface FileOwnership {
  path: string;
  mode: 'create' | 'modify' | 'read-only';
}
```

### 5.3 Dependency-Aware Dispatch

The orchestrator walks the dependency graph topologically. Independent subtasks launch in parallel. When a subtask completes, its dependents become eligible.

Example — "Add REST API with tests and docs":
```
Subtask 1: Create user model           (no deps -> starts immediately)
Subtask 2: Create API routes           (depends on 1)
Subtask 3: Write tests                 (depends on 2)  } parallel
Subtask 4: Update API docs             (depends on 2)  }
```

Max parallel workers: 3 (configurable via `--workers N`).

### 5.4 File-Lock Protocol

Default: file ownership assigned from plan. When a worker needs an unplanned file:

1. Worker sends `REQUEST_FILE` to orchestrator with path + reason
2. Orchestrator checks: is the owner done with the file?
3. Available -> grants ownership, worker continues
4. Locked -> worker queues and waits (or orchestrator reorders)
5. `--auto` mode: auto-resolves. Supervised: asks user.

**Deadlock prevention:** The orchestrator maintains a wait graph. Before granting a file-lock request, it checks for cycles (Worker A waits on B, B waits on A). If a cycle is detected:
1. The worker with the lower-priority subtask (later in dependency order) is cancelled
2. Its partial work is saved, and it's re-queued to run after the blocking worker completes
3. In supervised mode, the user is informed and can choose an alternative resolution

**Dependency graph validation:** The planner's output is validated for DAG properties before dispatch. If the LLM generates a cyclic dependency graph, the orchestrator rejects the plan and re-prompts the planner with an explicit "no cycles" constraint.

---

## 6. Worker

### 6.1 Evolved from `jam run`

Each worker is a focused agentic loop scoped to one subtask. Differences from current `jam run`:

| Aspect | `jam run` (current) | Worker (new) |
|--------|---------------------|--------------|
| Scope | Entire user prompt | Single subtask |
| Max rounds | 15 fixed | Dynamic (estimated, default 20, max 50) |
| Tools | All tools, flat | All tools + orchestrator IPC |
| Context | One shared window | Own WorkingMemory + prior subtask summary |
| Completion | Model stops calling tools | Meets validationCommand + model signals done |

### 6.2 Worker Lifecycle

```
1. INIT      — Receives subtask, file ownership, prior context summary
2. PLAN      — Quick local plan (generateExecutionPlan in readwrite mode)
3. EXECUTE   — Agentic loop: read -> think -> write -> verify
4. VALIDATE  — Runs subtask's validationCommand if provided
5. REPORT    — Returns WorkerResult to orchestrator
```

### 6.3 WorkerResult

```typescript
interface WorkerResult {
  subtaskId: string;
  status: 'completed' | 'failed' | 'blocked';
  filesChanged: FileChange[];
  summary: string;                 // LLM-generated summary
  tokensUsed: TokenUsage;
  error?: string;
}

interface FileChange {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  diff: string;                    // unified diff
}
```

### 6.4 Context Handoff

When subtask B depends on completed subtask A, orchestrator passes:

```typescript
interface SubtaskContext {
  priorSummary: string;           // what was done
  filesAvailable: string[];       // files created/modified by prior subtasks
  planReminder: string;           // current subtask description + context
}
```

Each worker starts with a fresh context window — no accumulated history from prior subtasks.

### 6.5 Error Recovery

- Worker fails -> orchestrator gets error + context summary
- `--auto`: retry once with error context, then skip subtask, continue remaining
- Supervised: ask user to retry, skip, or abort
- Blocked (file-lock timeout): orchestrator reorders or escalates

### 6.6 Round Budget Policy

Each subtask has an `estimatedRounds` from the planner (default 20, max 50).

- At `estimatedRounds` reached: orchestrator injects a `StepVerifier` check. If verifier says `ready-to-answer` or `need-more` (with progress), worker gets 5 bonus rounds.
- At `estimatedRounds + 5`: hard stop. Worker must synthesize a result from whatever it has.
- At `estimatedRounds * 0.5`: if no tool calls have been made, orchestrator flags the worker as potentially stuck and injects a correction hint.
- The orchestrator tracks actual vs estimated rounds per subtask. For later subtasks in the same plan, it adjusts estimates based on observed drift (e.g., if first two subtasks took 2x estimated, scale up remaining estimates).

---

## 7. Tiered Permissions

### 7.1 Three Tiers

```typescript
type PermissionTier = 'safe' | 'moderate' | 'dangerous';
```

| Tier | Examples | Supervised | `--auto` |
|------|----------|-----------|----------|
| Safe | `ls`, `cat`, `git status`, `git diff`, `npm test`, `npx tsc`, file reads | Auto-approve | Auto-approve |
| Moderate | `npm install`, `git add`, `git commit`, `mkdir`, `rm` (single file), file writes, `curl` | Auto-approve | Auto-approve |
| Dangerous | `rm -rf`, `git push`, `git reset`, `chmod`, `sudo`, piped commands with write side-effects | Confirm always | Confirm once per type |

"Confirm once per type" in `--auto`: approving `git push` once auto-approves subsequent `git push` in that session. `git push --force` is a separate confirmation.

### 7.2 Relationship with Existing `DANGEROUS_PATTERNS`

The existing `run_command.ts` has a hardcoded `DANGEROUS_PATTERNS` blocklist (`rm -rf /`, `sudo`, `mkfs`, etc.) that performs a hard block — commands are rejected outright regardless of user confirmation.

The tiered permission system layers on top:
- **`DANGEROUS_PATTERNS` remains as an unoverridable safety floor.** These commands are always blocked, even in `--auto` mode, even if the user adds them to their `safe` config. They represent catastrophic system-level risk.
- **Tiered permissions handle everything else.** Commands not in the hard-block list are classified as safe/moderate/dangerous and subject to the confirmation rules in Section 7.1.

```
Command received
  -> DANGEROUS_PATTERNS check (hard block, unoverridable)
  -> Tier classifier (safe/moderate/dangerous)
  -> Confirmation rules based on tier + mode
  -> Sandbox wrapper (if moderate/dangerous)
  -> Execute
```

### 7.3 Classifier

Pattern matching on command strings. Built-in defaults with user overrides in config:

```yaml
agent:
  permissions:
    safe: ["npm test", "cargo test", "go test"]
    dangerous: ["docker rm", "kubectl delete"]
```

---

## 8. Sandbox

### 8.1 OS-Level Command Sandboxing

Wraps command execution for moderate and dangerous tiers.

```typescript
interface SandboxConfig {
  filesystem: 'workspace-only' | 'unrestricted';  // default: workspace-only
  network: 'blocked' | 'allowed';                  // default: allowed
  timeout: number;                                  // default: 60s
}
```

### 8.2 Platform Implementation

| Platform | Primary | Fallback |
|----------|---------|----------|
| macOS | `sandbox-exec` (deprecated but functional) | Permissions-only |
| Linux | `unshare` + mount namespace, or `firejail` | Permissions-only |
| Windows | Permissions-only (v1) | Permissions-only |

- Safe-tier commands skip sandbox entirely (performance)
- Sandbox adds ~50ms overhead per invocation
- If OS sandbox unavailable, falls back to permissions-only with warning logged
- Windows v2: explore Windows Sandbox (lightweight VM) or WSL2 integration

**macOS note:** `sandbox-exec` is deprecated since macOS 10.15 but still functional. It may break on future macOS versions. `jam doctor` will verify sandbox availability on the current system. If `sandbox-exec` is unavailable, falls back to permissions-only with a warning. Future: investigate App Sandbox entitlements or seatbelt profiles as replacements.

### 8.3 Config

```yaml
agent:
  sandbox:
    filesystem: 'workspace-only'
    network: 'allowed'
```

---

## 9. Multimodal Input

### 9.1 Scope (v1)

Image input only: screenshots, diagrams, UI mockups.

### 9.2 Extended Message Type

```typescript
// src/providers/base.ts
type MessageContent = string | ContentPart[];

interface ContentPart {
  type: 'text' | 'image';
  text?: string;
  image?: {
    data: string;                    // base64-encoded
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  };
}

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;           // string for backwards compat
}
```

### 9.3 CLI Input

```bash
jam go "fix the layout bug" --image screenshot.png
jam go "match this design" --image design.png --image current.png
jam run "build this component" --image mockup.png
pbpaste | jam go "what's wrong with this error?"
jam go "build this" --image https://example.com/mockup.png
```

### 9.4 Provider Compatibility

```typescript
interface ProviderInfo {
  name: string;
  supportsStreaming: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;          // NEW
  contextWindow?: number;
}
```

When `supportsVision` is false, images are stripped and replaced with a notice: `[Image provided but this model doesn't support vision]`.

For Ollama, vision support depends on model (llava = yes, llama3.2 = no) — checked at runtime via model metadata.

### 9.5 Message Type Migration

The `Message.content` type change from `string` to `string | ContentPart[]` is a cross-cutting concern affecting ~50 call sites across providers, commands, and utils.

**Phased approach:**

**Phase 1 (agent engine only):** Introduce `ContentPart[]` only in `src/agent/` code paths. A `getTextContent(msg: Message): string` helper extracts text for backward compatibility. Existing commands (`ask`, `chat`, `commit`, etc.) continue using `string` content unchanged.

```typescript
// src/agent/multimodal.ts
function getTextContent(msg: Message): string {
  if (typeof msg.content === 'string') return msg.content;
  return msg.content
    .filter(p => p.type === 'text')
    .map(p => p.text!)
    .join('');
}
```

**Phase 2 (provider adapters):** Update provider adapters that support vision (OpenAI, Anthropic, Gemini, Ollama/llava) to handle `ContentPart[]` in `chatWithTools()`. Non-vision providers receive pre-flattened `string` content via `flattenForProvider()`:

```typescript
function flattenForProvider(messages: Message[], supportsVision: boolean): Message[] {
  if (supportsVision) return messages;
  return messages.map(m => ({
    ...m,
    content: typeof m.content === 'string'
      ? m.content
      : getTextContent(m) + (hasImages(m) ? '\n[Image provided but this model does not support vision]' : '')
  }));
}
```

**Phase 3 (full rollout):** Migrate remaining commands to support `ContentPart[]` if needed. This is optional — most commands will never need multimodal.

Existing string operations like `m.content.startsWith('[Tool result:')` in `agent.ts` work unchanged in Phase 1 because those code paths only receive `string` content.

### 9.6 Images in Agentic Loop

- Images attached to the initial user message only
- Workers receive text description of the image in their context summary (saves tokens)
- If a worker specifically needs the image (e.g., UI implementation subtask), orchestrator passes it through

---

## 10. Workspace Intelligence

### 10.1 Purpose

Before any planning or execution, build a comprehensive understanding of the codebase's conventions, patterns, and structure. This ensures the agent writes code that matches existing style and uses existing utilities.

### 10.2 WorkspaceProfile

```typescript
interface WorkspaceProfile {
  // Structure
  language: string;
  framework?: string;
  monorepo: boolean;
  srcLayout: string;
  entryPoints: string[];

  // Code conventions
  codeStyle: {
    indent: 'tabs' | 'spaces';
    indentSize: number;
    quotes: 'single' | 'double';
    semicolons: boolean;
    trailingCommas: boolean;
    namingConvention: 'camelCase' | 'snake_case' | 'PascalCase';
  };
  fileNaming: string;
  exportStyle: 'named' | 'default' | 'barrel';
  importStyle: 'relative' | 'alias';

  // Patterns
  errorHandling: string;
  logging: string;
  configPattern: string;

  // Testing
  testFramework: string;
  testLocation: string;
  testNaming: string;
  testStyle: string;
  coverageThreshold?: number;
  testCommand: string;

  // Git
  commitConvention: string;
  branchPattern: string;

  // Tooling
  packageManager: string;
  linter?: string;
  formatter?: string;
  typeChecker?: string;
  buildTool?: string;
}
```

### 10.3 Three-Layer Build

**Layer 1: Static analysis (no LLM, fast)**
- Parse package.json / pyproject.toml / Cargo.toml
- Read config files (.eslintrc, .prettierrc, tsconfig.json, biome.json)
- Sample 5-10 source files for style detection (indent, quotes, naming)
- Check test directory structure and naming patterns
- Read git log for commit convention
- Detect src layout by directory scanning

**Layer 2: Pattern extraction (one targeted LLM call)**
- Feed 3-4 representative source files to the model
- Ask: "What patterns does this codebase follow?"
- Extracts: error handling, logging, config, architectural patterns
- ~500 output tokens

**Layer 3: Cache and persist**
- Saved to `.jam/workspace-profile.json`
- Hash-based staleness check (hash of package.json + src/ file list + config files)
- If hash matches -> load from cache (instant)
- If hash differs -> rebuild (~2-3s static + 1 LLM call)

### 10.4 Integration with `jam intel`

Workspace Intelligence is an extension of `jam intel`, not a parallel system. The `jam intel` scanner is authoritative for structural analysis (framework detection, entry points, dependency graph). WorkspaceIntel adds the convention/style layer on top.

**Architecture:**
- Style analysis (indentation, quotes, naming, test patterns) is implemented as a new analyzer in `src/intel/analyzers/conventions.ts` that plugs into the existing scanner framework.
- `workspace-intel.ts` in `src/agent/` is a consumer that imports from `src/intel/`, not a standalone analyzer.
- The WorkspaceProfile references the intel graph as authoritative for structure, adding only conventions on top.

```typescript
async function buildWorkspaceProfile(root: string): Promise<WorkspaceProfile> {
  // Layer 1: static convention analysis (new analyzer in src/intel/)
  const conventions = await analyzeConventions(root);

  // Structural data from intel graph (authoritative)
  const intelGraph = await loadOrBuildIntelGraph(root);  // runs lightweight scan if not cached
  const structure = extractStructure(intelGraph);         // framework, entryPoints, srcLayout

  // Layer 2: LLM pattern extraction (only if cache stale)
  const patterns = await extractPatterns(root, { ...conventions, ...structure });

  // Merge: intel graph for structure, conventions analyzer for style, LLM for patterns
  const profile = merge(structure, conventions, patterns);
  await saveProfile(root, profile);
  return profile;
}
```

**Single source of truth:** Both `.jam/intel/` (code graph) and `.jam/workspace-profile.json` (conventions + patterns) are cached, but the profile's structural fields always come from the intel graph. No divergent representations.

### 10.5 Injection into Workers

The WorkspaceProfile is formatted and injected into every worker's system prompt:

```
You are working in a TypeScript/Express project.
- Style: 2-space indent, single quotes, semicolons, camelCase
- Files: kebab-case.ts with barrel exports (index.ts)
- Imports: relative paths (../utils/), not aliases
- Errors: custom JamError class with error codes (see src/utils/errors.ts)
- Logging: custom Logger with API key redaction (see src/utils/logger.ts)
- Tests: vitest, co-located *.test.ts files, describe/it style
- Run tests: npm test
- Commits: conventional (feat:, fix:, chore:)
```

---

## 11. Configuration

### 11.1 New Config Section

```yaml
# .jamrc.yml
agent:
  maxWorkers: 3
  defaultMode: 'supervised'          # 'supervised' | 'auto'
  maxRoundsPerWorker: 20
  permissions:
    safe: []                         # additional safe patterns
    dangerous: []                    # additional dangerous patterns
  sandbox:
    filesystem: 'workspace-only'     # 'workspace-only' | 'unrestricted'
    network: 'allowed'               # 'allowed' | 'blocked'
    timeout: 60000                   # ms per command
```

### 11.2 CLI Flags

```
jam go [options]
  --auto                Fully autonomous mode (no confirmations except dangerous)
  --image <path>        Attach image(s) to the task
  --workers <n>         Max parallel workers (default: 3)
  --no-sandbox          Disable OS-level sandboxing
  --yes                 Auto-confirm all prompts (alias for --auto)

jam run <prompt> [options]
  --auto                Fully autonomous (default behavior)
  --image <path>        Attach image(s)
  --workers <n>         Max parallel workers (default: 3)
  --no-sandbox          Disable OS-level sandboxing
  --file <path>         Read prompt from file
  --json                JSON output
  --quiet               Suppress non-essential output
```

---

## 12. Parallel Worker Output

### 12.1 Progress Display

When multiple workers run simultaneously in `jam go`:
- Multiplexed output with worker prefixes: `[Worker 1: Create user model]`, `[Worker 2: Write tests]`
- Each worker's tool calls and results shown inline under its prefix
- A status bar shows overall progress: `[2/4 subtasks complete | 3 workers active | 1,240 tokens used]`

In `jam run` (non-interactive):
- `--quiet`: only final summary
- Default: worker prefixes + tool calls on stderr, final result on stdout
- `--json`: structured JSON with per-worker results

---

## 13. Testing Strategy

### 13.1 Unit Tests

- `permissions.ts` — tier classification for known commands
- `sandbox.ts` — profile generation per platform (mocked OS calls)
- `file-lock.ts` — ownership assignment, request-grant flow
- `workspace-intel.ts` — static analysis on fixture projects
- `multimodal.ts` — image parsing, base64 encoding, provider fallback
- `planner.ts` — TaskPlan generation with dependency graph validation
- `types.ts` — type guards and validation

### 13.2 Integration Tests

- Orchestrator end-to-end: prompt -> plan -> workers -> merge -> verify
- Worker execution loop: subtask -> tool calls -> validation -> result
- Cross-platform sandbox behavior (skip on CI if OS sandbox unavailable)
- Multimodal message flow through providers (mocked provider)
- Workspace profiling on fixture projects (TypeScript, Python, Rust fixtures)

### 13.3 Manual Testing

- `jam go` interactive session: multi-step feature implementation
- `jam run` one-shot: bug fix with image input
- Parallel workers: task with 3+ independent subtasks
- Error recovery: intentionally failing subtask, verify retry + skip
- File conflict: two subtasks touching same file

---

## 14. Context Compaction & Token Optimization

Token efficiency is critical for long-running `jam go` sessions and expensive parallel `jam run` executions.

### 14.1 Worker-Level Compaction

Each worker uses its own `WorkingMemory` instance (reusing existing `src/utils/memory.ts`):
- **Tool result capping:** Large outputs truncated to `MAX_TOOL_RESULT_TOKENS` (1500) before injection
- **Scratchpad checkpoints:** Every 3 rounds, model summarizes findings so far — keeps context focused
- **Context compaction:** When messages approach 70% of context window, older rounds are summarized into a compact block via a separate LLM call

### 14.2 Orchestrator-Level Optimization

The orchestrator manages token budget across all workers:

```typescript
interface TokenBudget {
  maxPerWorker: number;          // derived from model's context window
  maxTotal: number;              // global cap across all workers
  spent: number;                 // running total
  remaining: number;
}
```

- **Pre-execution estimate:** Before dispatching, orchestrator estimates total token cost from the plan (subtask count * estimated rounds * avg tokens per round). If estimate exceeds budget, warns user and suggests reducing scope.
- **Live tracking:** Each worker reports `tokensUsed` in its result. Orchestrator tracks cumulative spend.
- **Budget enforcement:** If cumulative tokens exceed `maxTotal`, orchestrator pauses remaining subtasks and asks user whether to continue (supervised) or stops gracefully (auto).

### 14.3 Cross-Subtask Summary Compression

When passing context between dependent subtasks, summaries are compressed:
- Worker A's full output (potentially thousands of tokens) is summarized into a ~200 token `SubtaskContext.priorSummary`
- Only file paths and key decisions are preserved, not implementation details
- If Worker B needs specifics, it reads the files directly (cheaper than passing context)

### 14.4 `jam go` Session Compaction

In long interactive sessions, the orchestrator maintains a session-level working memory:
- After each completed task, the full orchestrator/worker history is compacted into a session summary
- New tasks start with the session summary + workspace profile, not the full history
- User can trigger manual compaction with `/compact` in the interactive console

---

## 15. Migration

### 15.1 Refactoring Plan

**`jam run` refactoring:**

`run.ts` (577 lines) delegates entirely to the orchestrator, even for single-subtask work. The orchestrator detects single-subtask plans and optimizes: no file-lock overhead, no parallel dispatch, just a single worker.

Existing guardrails migrate as follows:

| Guardrail | Moves to |
|-----------|----------|
| Write-enforcement (no code blocks as substitute for write_file) | `worker.ts` — part of the execution loop |
| Read-before-write gate | `worker.ts` — enforced per tool call |
| Shrinkage guard (write must be >= original length) | `worker.ts` — part of write validation |
| Critic evaluation | `orchestrator.ts` — runs on final merged result |
| Synthesis reminder | `worker.ts` — injected when worker is ready to report |
| Step verification | `worker.ts` — reuses existing `StepVerifier` |

**`jam go` rewrite:**

Current `go.ts` (69 lines) is a thin wrapper around `startChat()`. It becomes an interactive console that:
1. Reads user input in a loop (Ink TUI or readline)
2. Passes each task to the orchestrator
3. Displays worker progress with multiplexed output (`[Worker 1]`, `[Worker 2]` prefixes)
4. Accepts mid-flight commands: `/stop`, `/compact`, `/status`

**Feature flag during transition:**

`JAM_LEGACY_RUN=1` env var falls back to the old `run.ts` loop for users who hit issues. Removed after one minor version.

### 15.2 Backward Compatibility

- `jam run` CLI interface unchanged — same flags, same behavior, better results
- `jam go` gains new capabilities but retains interactive chat as its core
- Config is additive — new `agent` section with defaults, existing `toolPolicy`/`toolAllowlist` continue to work
- Existing tool policies layer with tiered permissions: if `toolPolicy: 'never'` for a tool, tiered permissions cannot override it

---

## 16. Error Codes

New `JamError` codes for agent-specific failures:

| Code | Description |
|------|-------------|
| `AGENT_PLAN_FAILED` | Planner could not generate a valid TaskPlan |
| `AGENT_PLAN_CYCLE` | Dependency graph contains a cycle |
| `AGENT_WORKER_TIMEOUT` | Worker exceeded its round budget |
| `AGENT_WORKER_CANCELLED` | Worker was cancelled by orchestrator or user |
| `AGENT_FILE_LOCK_CONFLICT` | File-lock deadlock detected |
| `AGENT_FILE_LOCK_TIMEOUT` | File-lock request timed out |
| `AGENT_BUDGET_EXCEEDED` | Total token budget exceeded |
| `AGENT_SANDBOX_UNAVAILABLE` | OS sandbox not available, running in permissions-only mode |
| `AGENT_RATE_LIMITED` | Provider rate limit hit, workers paused |
| `AGENT_MERGE_CONFLICT` | Workers produced conflicting file edits |

---

## 17. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Token cost explosion with parallel workers | Max worker cap (default 3), token budget with pre-execution estimates, context summaries instead of full history |
| Sandbox breaks dev tools | Fallback to permissions-only with warning; `--no-sandbox` escape hatch; `jam doctor` verifies sandbox availability |
| Workers produce conflicting edits | File-lock protocol with deadlock detection + orchestrator merge phase |
| Workspace profiling misdetects conventions | Cache is editable (`.jam/workspace-profile.json`), user can override; intel graph is authoritative for structure |
| Large tasks exceed context window | Per-worker fresh context with summary handoff, WorkingMemory compaction, session-level compaction in `jam go` |
| Windows sandbox gap | Tiered permissions + safePath still catch dangerous cases; sandbox in v2 |
| macOS `sandbox-exec` deprecation | Runtime check via `jam doctor`; permissions-only fallback; future migration to App Sandbox entitlements |
| Provider rate limits with parallel workers | Semaphore-based provider pool; automatic pause on 429; budget tracking |
| LLM generates cyclic dependency graph | DAG validation before dispatch; re-prompt planner on cycle detection |
| File-lock deadlock between workers | Wait-graph cycle detection; lower-priority worker cancelled and re-queued |
