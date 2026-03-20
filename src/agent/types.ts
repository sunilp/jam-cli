import type { TokenUsage } from '../providers/base.js';

// ── Permission Tiers
export type PermissionTier = 'safe' | 'moderate' | 'dangerous';
export type AgentMode = 'supervised' | 'auto';

// ── Task Planning
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

// ── Worker
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

// ── File Lock
export type FileLockRequest = {
  workerId: string;
  path: string;
  reason: string;
};

export type FileLockResponse = {
  granted: boolean;
  waitForWorker?: string;
};

// ── Sandbox
export interface SandboxConfig {
  filesystem: 'workspace-only' | 'unrestricted';
  network: 'blocked' | 'allowed';
  timeout: number;
}

// ── Token Budget
export interface TokenBudget {
  maxPerWorker: number;
  maxTotal: number;
  spent: number;
  remaining: number;
}

// ── Workspace Profile
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

// ── Multimodal (AgentMessage type — internal to agent module only)
export interface ContentPart {
  type: 'text' | 'image';
  text?: string;
  image?: {
    data: string;
    mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  };
}

export type MessageContent = string | ContentPart[];

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}

// ── Helpers

// dependencyGraph semantics: subtaskId → list of subtask IDs that must
// complete BEFORE this one can start (i.e., prerequisites, not dependents).

/** Validate a dependency graph is a DAG (no cycles). Returns null if valid, or the cycle path if invalid. */
export function validateDAG(graph: Map<string, string[]>): string[] | null {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const parent = new Map<string, string>();

  function dfs(node: string): string | null {
    if (stack.has(node)) return node;
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
