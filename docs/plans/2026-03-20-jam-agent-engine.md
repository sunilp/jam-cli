# Jam Agent Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared agent engine powering `jam go` (interactive) and `jam run` (one-shot) with orchestrated parallel workers, tiered permissions, OS sandboxing, multimodal image input, and workspace intelligence.

**Architecture:** New `src/agent/` module with orchestrator→worker pattern. Orchestrator decomposes tasks, dispatches workers in dependency order (parallel when independent), merges results. Each worker runs a focused agentic loop scoped to one subtask. Reuses existing tools, providers, memory, and planning infrastructure.

**Tech Stack:** TypeScript, vitest, Zod, Commander.js, existing ProviderAdapter/ToolRegistry/WorkingMemory

**Spec:** `docs/specs/2026-03-20-jam-agent-engine-design.md`

---

## Dependency Graph

```
Task 1 (types) ──┬── Task 4 (permissions) ── Task 5 (sandbox)
                  ├── Task 6 (multimodal)
                  ├── Task 7 (file-lock)
                  ├── Task 8 (provider-pool)
                  └── Task 10 (workspace-intel profile)
Task 2 (errors)       │
Task 3 (config)       │
Task 9 (conventions)──┘
                      │
                  Task 11 (planner)
                      │
                  Task 12 (worker)
                      │
                  Task 13 (orchestrator)
                      │
                  ┌────┴────┐
              Task 14    Task 15
              (jam run)  (jam go)
                  │
              Task 16 (barrel + integration)
```

Tasks 1-3 must go first. Tasks 4-10 depend on Tasks 1-3 and are parallelizable among themselves (except Task 10 depends on Task 9). Tasks 11+ are sequential. Task 13.5 (progress output) can be built alongside Task 13.

---

### Task 1: Agent Types

**Files:**
- Create: `src/agent/types.ts`
- Test: `src/agent/types.test.ts`

- [ ] **Step 1: Write the type definitions file**

```typescript
// src/agent/types.ts
import type { TokenUsage } from '../providers/base.js';

// ── Permission Tiers ────────────────────────────────────────────────

export type PermissionTier = 'safe' | 'moderate' | 'dangerous';

export type AgentMode = 'supervised' | 'auto';

// ── Task Planning ───────────────────────────────────────────────────

export interface TaskPlan {
  goal: string;
  subtasks: Subtask[];
  dependencyGraph: Map<string, string[]>; // subtaskId → [blockedBy]
}

export interface Subtask {
  id: string;
  description: string;
  files: FileOwnership[];
  estimatedRounds: number;
  validationCommand?: string;
}

export interface FileOwnership {
  path: string;
  mode: 'create' | 'modify' | 'read-only';
}

// ── Worker ──────────────────────────────────────────────────────────

export interface WorkerOptions {
  subtask: Subtask;
  context: SubtaskContext;
  signal: AbortSignal;
}

export interface SubtaskContext {
  priorSummary: string;
  filesAvailable: string[];
  planReminder: string;
}

export interface WorkerResult {
  subtaskId: string;
  status: 'completed' | 'failed' | 'blocked' | 'cancelled';
  filesChanged: FileChange[];
  summary: string;
  tokensUsed: TokenUsage;
  error?: string;
}

export interface FileChange {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  diff: string;
}

// ── File Lock ───────────────────────────────────────────────────────

export type FileLockRequest = {
  workerId: string;
  path: string;
  reason: string;
};

export type FileLockResponse = {
  granted: boolean;
  waitForWorker?: string;
};

// ── Sandbox ─────────────────────────────────────────────────────────

export interface SandboxConfig {
  filesystem: 'workspace-only' | 'unrestricted';
  network: 'blocked' | 'allowed';
  timeout: number;
}

// ── Token Budget ────────────────────────────────────────────────────

export interface TokenBudget {
  maxPerWorker: number;
  maxTotal: number;
  spent: number;
  remaining: number;
}

// ── Workspace Profile ───────────────────────────────────────────────

export interface WorkspaceProfile {
  language: string;
  framework?: string;
  monorepo: boolean;
  srcLayout: string;
  entryPoints: string[];
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
  errorHandling: string;
  logging: string;
  configPattern: string;
  testFramework: string;
  testLocation: string;
  testNaming: string;
  testStyle: string;
  coverageThreshold?: number;
  testCommand: string;
  commitConvention: string;
  branchPattern: string;
  packageManager: string;
  linter?: string;
  formatter?: string;
  typeChecker?: string;
  buildTool?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Validate a dependency graph is a DAG (no cycles). Returns null if valid, or the cycle path if invalid. */
export function validateDAG(graph: Map<string, string[]>): string[] | null {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const parent = new Map<string, string>(); // tracks DFS parent for cycle reconstruction

  function dfs(node: string): string | null {
    if (stack.has(node)) return node; // cycle back-edge found
    if (visited.has(node)) return null;

    visited.add(node);
    stack.add(node);

    for (const dep of graph.get(node) ?? []) {
      parent.set(dep, node);
      const cycleNode = dfs(dep);
      if (cycleNode !== null) return cycleNode;
    }

    stack.delete(node);
    return null;
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) {
      const cycleNode = dfs(node);
      if (cycleNode !== null) {
        // Reconstruct cycle path from the stack
        const cyclePath = [cycleNode];
        for (const n of [...stack].reverse()) {
          cyclePath.push(n);
          if (n === cycleNode) break;
        }
        return cyclePath.reverse();
      }
    }
  }
  return null;
}

// dependencyGraph semantics: subtaskId → list of subtask IDs that must
// complete BEFORE this one can start (i.e., prerequisites, not dependents).

/** Topological sort of subtask IDs. Throws if graph has cycles. */
export function topologicalSort(graph: Map<string, string[]>): string[] {
  const cycle = validateDAG(graph);
  if (cycle) throw new Error(`Cycle detected: ${cycle.join(' → ')}`);

  const sorted: string[] = [];
  const visited = new Set<string>();

  function visit(node: string): void {
    if (visited.has(node)) return;
    visited.add(node);
    for (const dep of graph.get(node) ?? []) {
      visit(dep);
    }
    sorted.push(node);
  }

  for (const node of graph.keys()) visit(node);
  return sorted;
}
```

- [ ] **Step 2: Write tests for DAG validation and topological sort**

```typescript
// src/agent/types.test.ts
import { describe, it, expect } from 'vitest';
import { validateDAG, topologicalSort } from './types.js';

describe('validateDAG', () => {
  it('returns null for valid DAG', () => {
    const graph = new Map([
      ['a', []],
      ['b', ['a']],
      ['c', ['b']],
    ]);
    expect(validateDAG(graph)).toBeNull();
  });

  it('returns cycle path for cyclic graph', () => {
    const graph = new Map([
      ['a', ['c']],
      ['b', ['a']],
      ['c', ['b']],
    ]);
    expect(validateDAG(graph)).not.toBeNull();
  });

  it('handles empty graph', () => {
    expect(validateDAG(new Map())).toBeNull();
  });

  it('handles self-loop', () => {
    const graph = new Map([['a', ['a']]]);
    expect(validateDAG(graph)).not.toBeNull();
  });
});

describe('topologicalSort', () => {
  it('sorts linear chain', () => {
    const graph = new Map([
      ['a', []],
      ['b', ['a']],
      ['c', ['b']],
    ]);
    const sorted = topologicalSort(graph);
    expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('b'));
    expect(sorted.indexOf('b')).toBeLessThan(sorted.indexOf('c'));
  });

  it('sorts diamond dependency', () => {
    const graph = new Map([
      ['a', []],
      ['b', ['a']],
      ['c', ['a']],
      ['d', ['b', 'c']],
    ]);
    const sorted = topologicalSort(graph);
    expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('b'));
    expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('c'));
    expect(sorted.indexOf('b')).toBeLessThan(sorted.indexOf('d'));
    expect(sorted.indexOf('c')).toBeLessThan(sorted.indexOf('d'));
  });

  it('throws on cycle', () => {
    const graph = new Map([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    expect(() => topologicalSort(graph)).toThrow('Cycle detected');
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/agent/types.test.ts`
Expected: All 7 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/agent/types.ts src/agent/types.test.ts
git commit -m "feat(agent): add shared types with DAG validation and topological sort"
```

---

### Task 2: Agent Error Codes

**Files:**
- Modify: `src/utils/errors.ts` (ErrorCode type + ERROR_HINTS)

- [ ] **Step 1: Write failing test**

```typescript
// src/agent/errors.test.ts
import { describe, it, expect } from 'vitest';
import { JamError } from '../utils/errors.js';

const AGENT_CODES = [
  'AGENT_PLAN_FAILED',
  'AGENT_PLAN_CYCLE',
  'AGENT_WORKER_TIMEOUT',
  'AGENT_WORKER_CANCELLED',
  'AGENT_FILE_LOCK_CONFLICT',
  'AGENT_FILE_LOCK_TIMEOUT',
  'AGENT_BUDGET_EXCEEDED',
  'AGENT_SANDBOX_UNAVAILABLE',
  'AGENT_RATE_LIMITED',
  'AGENT_MERGE_CONFLICT',
] as const;

describe('agent error codes', () => {
  for (const code of AGENT_CODES) {
    it(`creates JamError with code ${code}`, () => {
      const err = new JamError(`test ${code}`, code);
      expect(err.code).toBe(code);
      expect(err.hint).toBeDefined();
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/errors.test.ts`
Expected: FAIL — error codes not recognized by TypeScript.

- [ ] **Step 3: Add agent error codes to ErrorCode type and ERROR_HINTS**

Modify `src/utils/errors.ts`:
- Add to `ErrorCode` type union: `'AGENT_PLAN_FAILED' | 'AGENT_PLAN_CYCLE' | 'AGENT_WORKER_TIMEOUT' | 'AGENT_WORKER_CANCELLED' | 'AGENT_FILE_LOCK_CONFLICT' | 'AGENT_FILE_LOCK_TIMEOUT' | 'AGENT_BUDGET_EXCEEDED' | 'AGENT_SANDBOX_UNAVAILABLE' | 'AGENT_RATE_LIMITED' | 'AGENT_MERGE_CONFLICT'`
- Add to `ERROR_HINTS`:
  - `AGENT_PLAN_FAILED`: `'The AI could not generate a valid execution plan. Try simplifying your task or breaking it into smaller pieces.'`
  - `AGENT_PLAN_CYCLE`: `'The execution plan has circular dependencies. This is a bug — please report it.'`
  - `AGENT_WORKER_TIMEOUT`: `'A worker exceeded its round budget. Try increasing maxRoundsPerWorker in config.'`
  - `AGENT_WORKER_CANCELLED`: `'Worker was cancelled. This may be due to a dependency failure or user abort.'`
  - `AGENT_FILE_LOCK_CONFLICT`: `'Two workers tried to edit the same file simultaneously. The orchestrator resolved the conflict.'`
  - `AGENT_FILE_LOCK_TIMEOUT`: `'A file lock request timed out. Another worker may be stuck.'`
  - `AGENT_BUDGET_EXCEEDED`: `'Token budget exceeded. Reduce task scope or increase maxTotal in agent config.'`
  - `AGENT_SANDBOX_UNAVAILABLE`: `'OS sandbox not available. Running with permissions-only. Run jam doctor to check.'`
  - `AGENT_RATE_LIMITED`: `'Provider rate limit hit. Workers paused automatically. Wait and retry.'`
  - `AGENT_MERGE_CONFLICT`: `'Workers produced conflicting file edits. Manual resolution may be needed.'`

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/errors.test.ts`
Expected: All 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/errors.ts src/agent/errors.test.ts
git commit -m "feat(agent): add agent-specific error codes and hints"
```

---

### Task 3: Agent Config Schema

**Files:**
- Modify: `src/config/schema.ts`
- Test: `src/agent/config.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/agent/config.test.ts
import { describe, it, expect } from 'vitest';
import { JamConfigSchema } from '../config/schema.js';

describe('agent config schema', () => {
  it('provides defaults when agent section is omitted', () => {
    const result = JamConfigSchema.parse({});
    expect(result.agent).toBeDefined();
    expect(result.agent.maxWorkers).toBe(3);
    expect(result.agent.defaultMode).toBe('supervised');
    expect(result.agent.maxRoundsPerWorker).toBe(20);
    expect(result.agent.sandbox.filesystem).toBe('workspace-only');
    expect(result.agent.sandbox.network).toBe('allowed');
    expect(result.agent.sandbox.timeout).toBe(60000);
    expect(result.agent.permissions.safe).toEqual([]);
    expect(result.agent.permissions.dangerous).toEqual([]);
  });

  it('validates custom agent config', () => {
    const result = JamConfigSchema.parse({
      agent: {
        maxWorkers: 5,
        defaultMode: 'auto',
        permissions: { safe: ['npm test'], dangerous: ['docker rm'] },
        sandbox: { filesystem: 'unrestricted', network: 'blocked', timeout: 30000 },
      },
    });
    expect(result.agent.maxWorkers).toBe(5);
    expect(result.agent.defaultMode).toBe('auto');
    expect(result.agent.permissions.safe).toEqual(['npm test']);
    expect(result.agent.sandbox.network).toBe('blocked');
  });

  it('rejects invalid mode', () => {
    expect(() =>
      JamConfigSchema.parse({ agent: { defaultMode: 'yolo' } })
    ).toThrow();
  });

  it('rejects maxWorkers < 1', () => {
    expect(() =>
      JamConfigSchema.parse({ agent: { maxWorkers: 0 } })
    ).toThrow();
  });

  it('rejects maxRoundsPerWorker out of bounds', () => {
    expect(() =>
      JamConfigSchema.parse({ agent: { maxRoundsPerWorker: 0 } })
    ).toThrow();
    expect(() =>
      JamConfigSchema.parse({ agent: { maxRoundsPerWorker: 51 } })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/config.test.ts`
Expected: FAIL — `result.agent` is undefined.

- [ ] **Step 3: Add AgentConfigSchema to config/schema.ts**

Add before `JamConfigSchema`:

```typescript
const AgentPermissionsSchema = z.object({
  safe: z.array(z.string()).default([]),
  dangerous: z.array(z.string()).default([]),
});

const AgentSandboxSchema = z.object({
  filesystem: z.enum(['workspace-only', 'unrestricted']).default('workspace-only'),
  network: z.enum(['allowed', 'blocked']).default('allowed'),
  timeout: z.number().int().positive().default(60000),
});

export const AgentConfigSchema = z.object({
  maxWorkers: z.number().int().min(1).max(10).default(3),
  defaultMode: z.enum(['supervised', 'auto']).default('supervised'),
  maxRoundsPerWorker: z.number().int().min(1).max(50).default(20),
  permissions: AgentPermissionsSchema.default({}),
  sandbox: AgentSandboxSchema.default({}),
});
```

Add to `JamConfigSchema`: `agent: AgentConfigSchema.default({}),`

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/config.test.ts`
Expected: All 4 tests pass.

- [ ] **Step 5: Run full test suite to verify no regressions**

Run: `npx vitest run`
Expected: All existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/config/schema.ts src/agent/config.test.ts
git commit -m "feat(agent): add agent config schema with permissions, sandbox, and worker settings"
```

---

### Task 4: Tiered Permissions

**Files:**
- Create: `src/agent/permissions.ts`
- Test: `src/agent/permissions.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// src/agent/permissions.test.ts
import { describe, it, expect } from 'vitest';
import { classifyCommand, PermissionClassifier, ApprovalTracker, isHardBlocked } from './permissions.js';

describe('classifyCommand', () => {
  it('classifies safe commands', () => {
    expect(classifyCommand('ls')).toBe('safe');
    expect(classifyCommand('cat file.txt')).toBe('safe');
    expect(classifyCommand('git status')).toBe('safe');
    expect(classifyCommand('git diff')).toBe('safe');
    expect(classifyCommand('npm test')).toBe('safe');
    expect(classifyCommand('npx vitest run')).toBe('safe');
    expect(classifyCommand('node script.js')).toBe('safe');
  });

  it('classifies moderate commands', () => {
    expect(classifyCommand('npm install express')).toBe('moderate');
    expect(classifyCommand('git add .')).toBe('moderate');
    expect(classifyCommand('git commit -m "msg"')).toBe('moderate');
    expect(classifyCommand('mkdir -p src/agent')).toBe('moderate');
    expect(classifyCommand('rm file.txt')).toBe('moderate');
    expect(classifyCommand('curl https://example.com')).toBe('moderate');
  });

  it('classifies dangerous commands', () => {
    expect(classifyCommand('rm -rf node_modules')).toBe('dangerous');
    expect(classifyCommand('git push origin main')).toBe('dangerous');
    expect(classifyCommand('git reset --hard')).toBe('dangerous');
    expect(classifyCommand('chmod 755 script.sh')).toBe('dangerous');
    expect(classifyCommand('echo "x" | bash')).toBe('dangerous');
  });
});

describe('PermissionClassifier', () => {
  it('respects custom safe overrides', () => {
    const classifier = new PermissionClassifier({
      safe: ['docker build'],
      dangerous: [],
    });
    expect(classifier.classify('docker build .')).toBe('safe');
  });

  it('respects custom dangerous overrides', () => {
    const classifier = new PermissionClassifier({
      safe: [],
      dangerous: ['kubectl delete'],
    });
    expect(classifier.classify('kubectl delete pod foo')).toBe('dangerous');
  });

  it('custom overrides take precedence over defaults', () => {
    const classifier = new PermissionClassifier({
      safe: ['git push'],
      dangerous: [],
    });
    // git push is normally dangerous, but user overrode it
    expect(classifier.classify('git push origin main')).toBe('safe');
  });

  it('hard-block cannot be overridden by custom safe list', () => {
    const classifier = new PermissionClassifier({
      safe: ['sudo'],
      dangerous: [],
    });
    expect(classifier.classify('sudo rm -rf /')).toBe('blocked');
  });
});

describe('isHardBlocked', () => {
  it('blocks sudo', () => {
    expect(isHardBlocked('sudo apt install')).toBe(true);
  });

  it('does not block normal commands', () => {
    expect(isHardBlocked('npm test')).toBe(false);
  });
});

describe('ApprovalTracker', () => {
  it('tracks approvals by command type', () => {
    const tracker = new ApprovalTracker();
    expect(tracker.isApproved('git push origin main')).toBe(false);
    tracker.approve('git push origin main');
    expect(tracker.isApproved('git push origin develop')).toBe(true);
  });

  it('treats git push --force as different type from git push', () => {
    const tracker = new ApprovalTracker();
    tracker.approve('git push origin main');
    // "git push" is approved, but this normalizes to first 2 words
    // so "git push --force" normalizes to "git push" — same type
    // This is intentional: --force is part of args, not the command type
    expect(tracker.isApproved('git push --force')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/permissions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement permissions.ts**

```typescript
// src/agent/permissions.ts
import type { PermissionTier } from './types.js';

const SAFE_PATTERNS = [
  /^ls\b/, /^cat\b/, /^head\b/, /^tail\b/, /^wc\b/, /^echo\b/,
  /^git\s+(status|diff|log|show|branch|tag|remote|rev-parse)\b/,
  /^npm\s+test\b/, /^npx\s+(vitest|jest|tsc|eslint|prettier)\b/,
  /^node\b/, /^deno\b/, /^bun\s+(test|run)\b/,
  /^cargo\s+test\b/, /^go\s+test\b/, /^python\s+-m\s+pytest\b/,
  /^pwd$/, /^whoami$/, /^date$/, /^which\b/, /^env$/,
  /^find\b/, /^grep\b/, /^rg\b/, /^fd\b/,
];

const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r|-[a-zA-Z]*f|--recursive|--force)\b/,
  /\bgit\s+(push|reset|rebase|force-push)\b/,
  /\bgit\s+checkout\s+--?\s/,
  /\bchmod\b/, /\bchown\b/,
  /\bsudo\b/, /\bsu\s/,
  /\|/, // piped commands
  /\bgit\s+branch\s+-[dD]\b/,
];

export function classifyCommand(command: string): PermissionTier {
  const trimmed = command.trim();

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) return 'dangerous';
  }

  for (const pattern of SAFE_PATTERNS) {
    if (pattern.test(trimmed)) return 'safe';
  }

  return 'moderate';
}

/** Check against the unoverridable hard-block list from run_command.ts.
 *  These are NEVER allowed, regardless of user config or mode. */
export function isHardBlocked(command: string): boolean {
  // Import DANGEROUS_PATTERNS from src/tools/run_command.ts
  // These patterns (rm -rf /, sudo, mkfs, etc.) are the safety floor.
  const HARD_BLOCK = [
    /\brm\s+(-\w*r\w*f|-\w*f\w*r)\s+\/\s*$/,
    /\bsudo\b/, /\bsu\s+-/, /\bmkfs\b/, /\bdd\b/,
    /\bchmod\s+777\s+\//, /\bshutdown\b/, /\breboot\b/,
  ];
  return HARD_BLOCK.some(p => p.test(command.trim()));
}

export class PermissionClassifier {
  private customSafe: string[];
  private customDangerous: string[];

  constructor(overrides: { safe: string[]; dangerous: string[] }) {
    this.customSafe = overrides.safe;
    this.customDangerous = overrides.dangerous;
  }

  classify(command: string): PermissionTier | 'blocked' {
    const trimmed = command.trim();

    // Hard-block check FIRST — unoverridable safety floor
    if (isHardBlocked(trimmed)) return 'blocked';

    // Custom overrides take precedence over defaults
    for (const pattern of this.customSafe) {
      if (trimmed.startsWith(pattern)) return 'safe';
    }
    for (const pattern of this.customDangerous) {
      if (trimmed.startsWith(pattern)) return 'dangerous';
    }

    return classifyCommand(trimmed);
  }
}

/** Tracks session-level approvals for "confirm once per type" in auto mode. */
export class ApprovalTracker {
  private approved = new Set<string>();

  /** Normalize command to its "type" (e.g., "git push" regardless of args). */
  private commandType(command: string): string {
    return command.trim().split(/\s+/).slice(0, 2).join(' ');
  }

  isApproved(command: string): boolean {
    return this.approved.has(this.commandType(command));
  }

  approve(command: string): void {
    this.approved.add(this.commandType(command));
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/permissions.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/permissions.ts src/agent/permissions.test.ts
git commit -m "feat(agent): add tiered permission classifier (safe/moderate/dangerous)"
```

---

### Task 5: Sandbox

**Files:**
- Create: `src/agent/sandbox.ts`
- Test: `src/agent/sandbox.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// src/agent/sandbox.test.ts
import { describe, it, expect, vi } from 'vitest';
import { detectSandboxStrategy, buildSandboxArgs } from './sandbox.js';

describe('detectSandboxStrategy', () => {
  it('returns sandbox-exec on darwin', () => {
    expect(detectSandboxStrategy('darwin')).toBe('sandbox-exec');
  });

  it('returns permissions-only on win32', () => {
    expect(detectSandboxStrategy('win32')).toBe('permissions-only');
  });

  it('returns unshare or permissions-only on linux', () => {
    const result = detectSandboxStrategy('linux');
    expect(['unshare', 'firejail', 'permissions-only']).toContain(result);
  });
});

describe('buildSandboxArgs', () => {
  it('wraps command with sandbox-exec on darwin', () => {
    const result = buildSandboxArgs('npm test', '/workspace', {
      filesystem: 'workspace-only',
      network: 'allowed',
      timeout: 60000,
    }, 'sandbox-exec');
    expect(result.command).toBe('sandbox-exec');
    expect(result.args).toContain('-p');
  });

  it('returns passthrough for permissions-only', () => {
    const result = buildSandboxArgs('npm test', '/workspace', {
      filesystem: 'workspace-only',
      network: 'allowed',
      timeout: 60000,
    }, 'permissions-only');
    expect(result.command).toBe('npm');
    expect(result.args[0]).toBe('test');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/sandbox.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement sandbox.ts**

Implement `detectSandboxStrategy()`, `buildSandboxArgs()`, and `executeSandboxed()` per spec Section 8. For macOS: generate `sandbox-exec` profile scoping filesystem to workspace. For Linux: try `unshare`/`firejail` detection. For Windows/fallback: passthrough with logging.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/sandbox.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/sandbox.ts src/agent/sandbox.test.ts
git commit -m "feat(agent): add OS-level command sandbox (macOS/Linux with fallback)"
```

---

### Task 6: Multimodal Input

**Files:**
- Create: `src/agent/multimodal.ts`
- Modify: `src/providers/base.ts` (add `supportsVision` to `ProviderInfo` — no Message type changes)
- Test: `src/agent/multimodal.test.ts`

**Key design decision:** Do NOT change `Message.content` from `string` to a union type. This would break ~50 call sites. Instead, define `AgentMessage` with `content: MessageContent` in `src/agent/types.ts`, used only within the agent module. `flattenForProvider()` converts `AgentMessage[]` → `Message[]` before passing to the adapter.

- [ ] **Step 1: Write tests**

```typescript
// src/agent/multimodal.test.ts
import { describe, it, expect } from 'vitest';
import { getTextContent, hasImages, flattenForProvider, loadImage } from './multimodal.js';

describe('getTextContent', () => {
  it('returns string content as-is', () => {
    expect(getTextContent({ role: 'user', content: 'hello' })).toBe('hello');
  });

  it('extracts text from ContentPart array', () => {
    expect(getTextContent({
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this' },
        { type: 'image', image: { data: 'abc', mediaType: 'image/png' } },
      ],
    })).toBe('Describe this');
  });

  it('joins multiple text parts', () => {
    expect(getTextContent({
      role: 'user',
      content: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' },
      ],
    })).toBe('Part 1Part 2');
  });
});

describe('hasImages', () => {
  it('returns false for string content', () => {
    expect(hasImages({ role: 'user', content: 'hello' })).toBe(false);
  });

  it('returns true when content has image parts', () => {
    expect(hasImages({
      role: 'user',
      content: [{ type: 'image', image: { data: 'abc', mediaType: 'image/png' } }],
    })).toBe(true);
  });
});

describe('flattenForProvider', () => {
  it('returns messages unchanged when supportsVision is true', () => {
    const msgs = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];
    expect(flattenForProvider(msgs, true)).toBe(msgs);
  });

  it('flattens multimodal to text with notice when no vision', () => {
    const msgs = [{
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'Describe this' },
        { type: 'image' as const, image: { data: 'abc', mediaType: 'image/png' as const } },
      ],
    }];
    const result = flattenForProvider(msgs, false);
    expect(typeof result[0].content).toBe('string');
    expect(result[0].content).toContain('Describe this');
    expect(result[0].content).toContain('[Image provided');
  });
});

describe('loadImage', () => {
  it('loads a local file and returns base64 + mediaType', async () => {
    // Create a tiny 1x1 PNG in memory for testing
    const { writeFile, unlink } = await import('node:fs/promises');
    const path = '/tmp/test-jam-image.png';
    const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(path, pngHeader);
    const result = await loadImage(path);
    expect(result.mediaType).toBe('image/png');
    expect(result.data).toBeTruthy();
    await unlink(path);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/multimodal.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add multimodal types to src/agent/types.ts and ProviderInfo**

Add to `src/agent/types.ts`:

```typescript
export interface ContentPart {
  type: 'text' | 'image';
  text?: string;
  image?: {
    data: string;
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  };
}

export type MessageContent = string | ContentPart[];

/** Agent-internal message type supporting multimodal content.
 *  Converted to standard Message (string content) via flattenForProvider(). */
export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}
```

Add `supportsVision?: boolean` to `ProviderInfo` in `src/providers/base.ts`. Do NOT change `Message.content` type.

- [ ] **Step 4: Implement multimodal.ts**

Implement `getTextContent()`, `hasImages()`, `flattenForProvider()`, `loadImage()` (reads file, detects media type from extension, returns base64).

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/agent/multimodal.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Run full test suite — no regressions expected**

Run: `npx vitest run`
Expected: All tests pass. `Message` type in `base.ts` is unchanged. Only `ProviderInfo` got a new optional field.

- [ ] **Step 7: Commit**

```bash
git add src/providers/base.ts src/agent/multimodal.ts src/agent/multimodal.test.ts
git commit -m "feat(agent): add multimodal image input with provider fallback"
```

---

### Task 7: File-Lock Manager

**Files:**
- Create: `src/agent/file-lock.ts`
- Test: `src/agent/file-lock.test.ts`

- [ ] **Step 1: Write tests**

Test ownership assignment, request-grant flow, deadlock detection (cycle in wait graph), release, and timeout.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/file-lock.test.ts`

- [ ] **Step 3: Implement file-lock.ts**

Implement `FileLockManager` class with:
- `assignOwnership(subtaskId, files: FileOwnership[])` — bulk assign from plan
- `requestFile(request: FileLockRequest): FileLockResponse` — check ownership, detect deadlock via wait-graph cycle detection
- `releaseAll(workerId: string)` — release all locks held by a worker
- `getOwner(path: string): string | undefined`
- Private `detectDeadlock(requestingWorker, waitForWorker): boolean` — DFS on wait graph

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/file-lock.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/file-lock.ts src/agent/file-lock.test.ts
git commit -m "feat(agent): add file-lock manager with deadlock detection"
```

---

### Task 8: Provider Pool (Semaphore)

**Files:**
- Create: `src/agent/provider-pool.ts`
- Test: `src/agent/provider-pool.test.ts`

- [ ] **Step 1: Write tests**

Test semaphore acquire/release, concurrency limit enforcement, rate-limit pause, and token usage aggregation.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement provider-pool.ts**

Implement `ProviderPool` class with:
- `constructor(adapter: ProviderAdapter, concurrencyLimit: number)`
- `acquire(): Promise<ProviderLease>` — blocks via promise queue if at limit
- `release(lease: ProviderLease)` — releases slot, resolves next waiter
- `pauseForRateLimit(retryAfterMs: number)` — pauses all acquires
- `getTotalTokens(): TokenUsage` — aggregated across all leases

`ProviderLease` wraps the adapter so token usage is tracked per-call.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/provider-pool.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/provider-pool.ts src/agent/provider-pool.test.ts
git commit -m "feat(agent): add provider pool with semaphore-based concurrency control"
```

---

### Task 9: Conventions Analyzer (src/intel/)

**Files:**
- Create: `src/intel/conventions.ts` (standalone function, NOT an AnalyzerPlugin — it needs root-level access to package.json, git log, config files, which doesn't fit the per-file `analyzeFile()` interface)
- Modify: `src/intel/index.ts` (add export for `analyzeConventions`)
- Test: `src/intel/conventions.test.ts`

- [ ] **Step 1: Write tests**

Test static analysis on the jam-cli project itself (or fixture): detect indent style (spaces/2), quotes (single), semicolons (true), naming convention (camelCase), test framework (vitest), test location (co-located), file naming (kebab-case.ts), package manager (npm), etc.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/intel/conventions.test.ts`

- [ ] **Step 3: Implement conventions.ts**

Implement `analyzeConventions(root: string)` as a standalone exported function that:
1. Reads `package.json` / `pyproject.toml` / `Cargo.toml` to detect language, packageManager, linter, formatter, typeChecker, buildTool, testFramework, testCommand
2. Reads `.eslintrc*`, `.prettierrc*`, `tsconfig.json`, `biome.json` for code style
3. Samples 5-10 source files (first `.ts`/`.js`/`.py` files found in `src/`), analyzes: indent char/size, quote style, semicolons, trailing commas, naming convention
4. Scans for test directories and test file naming pattern
5. Reads `git log --oneline -20` for commit convention detection
6. Returns partial `WorkspaceProfile` (conventions only, no framework/entryPoints — those come from intel graph)

Note: This is NOT an `AnalyzerPlugin`. It does not implement `analyzeFile()`. It is a root-level analysis function that reads project config files, samples source files, and queries git. It lives in `src/intel/` because it is code analysis, but it is consumed directly by `src/agent/workspace-intel.ts`.

- [ ] **Step 4: Add export to src/intel/index.ts**

Add: `export { analyzeConventions } from './conventions.js';`

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/intel/conventions.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/intel/conventions.ts src/intel/conventions.test.ts src/intel/index.ts
git commit -m "feat(intel): add conventions analyzer for code style and patterns detection"
```

---

### Task 10: Workspace Intelligence (Profile Builder)

**Files:**
- Create: `src/agent/workspace-intel.ts`
- Test: `src/agent/workspace-intel.test.ts`

- [ ] **Step 1: Write tests**

Test profile building with cache hit (returns cached), cache miss (rebuilds), hash-based invalidation, integration with intel graph when available, and `formatProfileForPrompt()` output.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement workspace-intel.ts**

Implement:
- `buildWorkspaceProfile(root, adapter?)` — Layer 1: `analyzeConventions()`, Layer 2: load/build intel graph for structure, Layer 3: LLM pattern extraction if cache stale. Returns `WorkspaceProfile`.
- `loadCachedProfile(root): WorkspaceProfile | null` — reads `.jam/workspace-profile.json`, checks hash
- `computeProfileHash(root): string` — hash of package.json + src/ file list + config files
- `formatProfileForPrompt(profile: WorkspaceProfile): string` — formatted string for system prompt injection

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/workspace-intel.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/workspace-intel.ts src/agent/workspace-intel.test.ts
git commit -m "feat(agent): add workspace intelligence with cached profiling"
```

---

### Task 11: Planner

**Files:**
- Create: `src/agent/planner.ts`
- Test: `src/agent/planner.test.ts`

- [ ] **Step 1: Write tests**

Test plan generation with mocked provider (returns JSON TaskPlan), DAG validation of generated plan, re-prompt on cycle detection, single-subtask optimization, and file ownership extraction.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement planner.ts**

Implement `generateTaskPlan(adapter, prompt, profile, options)`:
1. Build planning prompt with workspace profile context
2. Call `adapter.chatWithTools()` (or `streamCompletion`) with planning prompt requesting JSON output
3. Parse JSON response into `TaskPlan`
4. Validate DAG with `validateDAG()` — if cycle, re-prompt once with "no cycles" constraint
5. Return validated `TaskPlan`
6. On failure, throw `AGENT_PLAN_FAILED`

Also implement `estimateTokenCost(plan: TaskPlan): number` for pre-execution budgeting.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/planner.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/planner.ts src/agent/planner.test.ts
git commit -m "feat(agent): add task planner with DAG validation and token cost estimation"
```

---

### Task 12: Worker

**Files:**
- Create: `src/agent/worker.ts`
- Test: `src/agent/worker.test.ts`

- [ ] **Step 1: Write tests**

Test worker execution with mocked provider:
- Completes a subtask in N rounds (reads file, writes file, returns result)
- Respects `AbortSignal` cancellation — returns `status: 'cancelled'`
- On cancellation, rolls back uncommitted file writes via `git checkout -- <files>`
- Enforces round budget (stops at `estimatedRounds + 5`)
- At `estimatedRounds * 0.5` with no tool calls, injects correction hint (stuck detection)
- Returns `WorkerResult` with correct `filesChanged` and `summary`
- Runs `validationCommand` if provided
- Handles tool call errors gracefully
- Uses `ApprovalTracker` for "confirm once per type" in auto mode
- Checks `isHardBlocked()` before executing any command

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement worker.ts**

Implement `executeWorker(options: WorkerOptions, deps: WorkerDeps): Promise<WorkerResult>`:

`WorkerDeps` includes: adapter (via ProviderPool lease), toolRegistry, mcpManager, workspaceRoot, workspaceProfile, agentMode, permissionClassifier, sandboxConfig.

The execution loop:
1. Build system prompt from workspace profile + subtask description
2. Build initial messages from `SubtaskContext`
3. Create `WorkingMemory` instance
4. Loop up to `estimatedRounds + 5`:
   - Check `signal.aborted` → return cancelled result
   - Check scratchpad/compaction triggers
   - Call `adapter.chatWithTools()` with all tool schemas
   - If no tool calls → worker is done, return result
   - Execute tool calls through registry (with permission classifier + sandbox)
   - Track file changes (diffs captured via `git diff` after each write)
   - StepVerifier check every 3 rounds
5. Run `validationCommand` if provided
6. Generate summary via LLM
7. Return `WorkerResult`

Migrate guardrails from `run.ts`:
- Write-enforcement: detect code blocks in assistant content, re-prompt
- Read-before-write: auto-read files before allowing writes
- Shrinkage guard: warn if write is shorter than original

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/worker.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/worker.ts src/agent/worker.test.ts
git commit -m "feat(agent): add worker execution loop with guardrails and round budget"
```

---

### Task 13: Orchestrator

**Files:**
- Create: `src/agent/orchestrator.ts`
- Test: `src/agent/orchestrator.test.ts`

- [ ] **Step 1: Write tests**

Test orchestrator end-to-end with mocked planner and workers:
- Single-subtask plan: dispatches one worker, no file-lock overhead, returns result
- Multi-subtask with deps: dispatches in topological order
- Parallel dispatch: independent subtasks run concurrently (verify via timing)
- Error recovery (auto mode): failed worker retried once, then skipped
- Error recovery (supervised mode): prompts user to retry/skip/abort
- File-lock conflict: two workers requesting same file — deadlock detected, lower-priority worker re-queued
- Token budget enforcement: pre-execution estimate warns user, stops when budget exceeded
- Cancellation: user abort propagates to workers
- Adaptive round estimates: if first subtask took 2x estimated, scale up remaining
- Cross-subtask summary compression: prior worker output summarized to ~200 tokens

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement orchestrator.ts**

Implement `Orchestrator` class:

```typescript
class Orchestrator {
  constructor(deps: OrchestratorDeps) {}

  async execute(prompt: string, options: OrchestratorOptions): Promise<OrchestratorResult> {
    // 1. Build workspace profile
    // 2. Generate task plan
    // 3. Estimate token cost, warn if high
    // 4. Assign file ownership from plan
    // 5. Walk dependency graph topologically
    // 6. Dispatch workers (parallel when independent, up to maxWorkers)
    // 7. Monitor: handle file-lock requests, track progress
    // 8. Collect results, resolve conflicts
    // 9. Run validation commands
    // 10. Generate summary
    return result;
  }
}
```

`OrchestratorDeps`: adapter, toolRegistry, mcpManager, config, workspaceRoot.
`OrchestratorOptions`: prompt, images, mode (supervised/auto), maxWorkers, signal.
`OrchestratorResult`: results per subtask, total tokens, files changed, summary.

Key behaviors:
- Uses `Promise.all()` for parallel worker dispatch within concurrency limit
- Uses `ProviderPool` for safe adapter access
- Uses `FileLockManager` for file ownership
- Aggregates `WorkerResult` array
- Calls `criticEvaluate()` on merged result if provider supports it
- Progress callback for UI (worker started, completed, tool call, etc.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/orchestrator.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/orchestrator.ts src/agent/orchestrator.test.ts
git commit -m "feat(agent): add orchestrator with parallel dispatch, file-lock, and budget control"
```

---

### Task 13.5: Progress Reporter

**Files:**
- Create: `src/agent/progress.ts`
- Test: `src/agent/progress.test.ts`

- [ ] **Step 1: Write tests**

Test progress output rendering:
- Multiplexed worker output: `[Worker 1: Create model]` prefix format
- Status bar: `[2/4 subtasks complete | 3 workers active | 1,240 tokens used]`
- Quiet mode: suppresses all output
- JSON mode: structured output per worker
- Event callbacks: worker started, tool call, tool result, worker completed, worker failed

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/agent/progress.test.ts`

- [ ] **Step 3: Implement progress.ts**

Implement `ProgressReporter` class:

```typescript
type OutputMode = 'interactive' | 'default' | 'quiet' | 'json';

interface ProgressEvent {
  type: 'worker-started' | 'worker-completed' | 'worker-failed' | 'tool-call' | 'tool-result' | 'status-update';
  workerId: string;
  workerLabel: string;
  data?: unknown;
}

class ProgressReporter {
  constructor(private mode: OutputMode, private write: (msg: string) => void) {}

  onEvent(event: ProgressEvent): void { /* format and write based on mode */ }
  updateStatusBar(completed: number, total: number, activeWorkers: number, tokens: number): void {}
  getJsonResults(): unknown[] { /* for --json mode */ }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/agent/progress.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/progress.ts src/agent/progress.test.ts
git commit -m "feat(agent): add progress reporter with multiplexed worker output"
```

---

### Task 14: Upgrade `jam run`

**Files:**
- Modify: `src/commands/run.ts`
- Modify: `src/index.ts` (add new CLI flags)
- Test: `src/commands/run.test.ts` (add integration tests)

- [ ] **Step 1: Write integration test**

Test that `runRun` with a simple prompt uses the orchestrator, respects `--auto`, `--workers`, and `--image` flags. Mock the provider to return a single-subtask plan.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Refactor run.ts to delegate to Orchestrator**

Replace the core agentic loop in `runRun()` with:
1. Create `Orchestrator` with deps
2. Call `orchestrator.execute(prompt, { mode, maxWorkers, images, signal })`
3. Render `OrchestratorResult` to stdout
4. Keep `JAM_LEGACY_RUN=1` env var check to fall back to old loop

Keep existing CLI interface. Add new flags:
- `--auto`: set agent mode to 'auto' (autonomous execution with confirm-once-per-type for dangerous)
- `--yes` / `-y`: retained for backward compat — sets `toolPolicy: 'always'`. `--auto` implies `--yes`.
- `--workers <n>`: max parallel workers
- `--image <path>`: repeatable, attach images
- `--file <path>`: read prompt from file (complements existing inline arg + stdin)
- `--no-sandbox`: disable sandbox
- `--json` and `--quiet`: existing flags, but update behavior for parallel worker output

- [ ] **Step 4: Update src/index.ts command registration**

Add new options to the `run` command:
```typescript
.option('--auto', 'Fully autonomous mode')
.option('--workers <n>', 'Max parallel workers', '3')
.option('--image <path>', 'Attach image', collect)  // collect into array
.option('--no-sandbox', 'Disable OS sandbox')
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/commands/run.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass including existing run tests.

- [ ] **Step 7: Commit**

```bash
git add src/commands/run.ts src/index.ts src/commands/run.test.ts
git commit -m "feat(agent): upgrade jam run to use orchestrator with parallel workers"
```

---

### Task 15: Rewrite `jam go`

**Files:**
- Modify: `src/commands/go.ts`
- Modify: `src/index.ts` (add new CLI flags)
- Test: `src/commands/go.test.ts`

- [ ] **Step 1: Write tests**

Test the interactive loop:
- Processes a single task via orchestrator
- Handles `/stop` command (cancels current orchestrator)
- Handles `/compact` command (compacts session memory)
- Handles `/status` command (shows token usage + worker status)
- Session compaction between tasks (prior task summarized)

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Rewrite go.ts**

Replace the `startChat()` delegation with an interactive console:
1. Load config, create provider, workspace profile
2. Create session-level context (session summary, workspace profile)
3. Enter readline loop:
   - Read user input
   - Check for commands (`/stop`, `/compact`, `/status`, `/exit`)
   - Create `Orchestrator` and call `execute(input, { mode, images, signal })`
   - Display multiplexed worker output
   - After completion, compact session context
4. Handle Ctrl+C gracefully (abort current orchestrator, don't exit)

Add CLI flags: `--auto`, `--workers <n>`, `--image <path>`, `--no-sandbox`

- [ ] **Step 4: Update src/index.ts command registration**

Add new options to `go` command.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/commands/go.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands/go.ts src/index.ts src/commands/go.test.ts
git commit -m "feat(agent): rewrite jam go as interactive agent console with session memory"
```

---

### Task 16: Barrel Export & Integration Test

**Files:**
- Create: `src/agent/index.ts`
- Create: `src/agent/integration.test.ts`

- [ ] **Step 1: Create barrel export**

```typescript
// src/agent/index.ts
export * from './types.js';
export { PermissionClassifier, classifyCommand } from './permissions.js';
export { detectSandboxStrategy, buildSandboxArgs, executeSandboxed } from './sandbox.js';
export { getTextContent, hasImages, flattenForProvider, loadImage } from './multimodal.js';
export { FileLockManager } from './file-lock.js';
export { ProviderPool } from './provider-pool.js';
export { buildWorkspaceProfile, formatProfileForPrompt } from './workspace-intel.js';
export { generateTaskPlan } from './planner.js';
export { executeWorker } from './worker.js';
export { Orchestrator } from './orchestrator.js';
```

- [ ] **Step 2: Write integration test**

End-to-end test with a mocked provider that simulates a 2-subtask plan:
1. Subtask 1: create a file (worker reads dir, writes file)
2. Subtask 2: modify the file (depends on subtask 1, reads file, writes modified version)

Verify: files created/modified, dependency order respected, orchestrator result has correct summaries and token usage.

- [ ] **Step 3: Run integration test**

Run: `npx vitest run src/agent/integration.test.ts`
Expected: Pass.

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing + new).

- [ ] **Step 5: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/agent/index.ts src/agent/integration.test.ts
git commit -m "feat(agent): add barrel export and end-to-end integration test"
```

- [ ] **Step 7: Final commit — version bump**

Update `package.json` version to `0.8.0` (major feature addition).

```bash
git add package.json
git commit -m "chore: bump version to 0.8.0 for agent engine"
```
