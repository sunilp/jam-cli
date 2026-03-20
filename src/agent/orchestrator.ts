import type { ProviderAdapter, TokenUsage, ToolDefinition } from '../providers/base.js';
import type { TaskPlan, WorkerResult, AgentMode } from './types.js';
import { topologicalSort } from './types.js';
import { generateTaskPlan, estimateTokenCost } from './planner.js';
import { buildWorkspaceProfile } from './workspace-intel.js';
import { executeWorker } from './worker.js';
import { FileLockManager } from './file-lock.js';
import { ProviderPool } from './provider-pool.js';

export interface OrchestratorDeps {
  adapter: ProviderAdapter;
  workspaceRoot: string;
  toolSchemas: ToolDefinition[];
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
}

export interface OrchestratorOptions {
  mode: AgentMode;
  maxWorkers: number;
  images?: string[];           // image file paths
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  type: 'plan-ready' | 'worker-started' | 'worker-completed' | 'worker-failed' | 'all-done';
  subtaskId?: string;
  message: string;
}

export interface OrchestratorResult {
  plan: TaskPlan;
  results: WorkerResult[];
  totalTokens: TokenUsage;
  filesChanged: string[];
  summary: string;
}

export class Orchestrator {
  private deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  async execute(prompt: string, options: OrchestratorOptions): Promise<OrchestratorResult> {
    const { adapter, workspaceRoot, toolSchemas, executeTool } = this.deps;
    const signal = options.signal ?? AbortSignal.timeout(600000); // 10min default

    // 1. Build workspace profile
    const profile = await buildWorkspaceProfile(workspaceRoot);

    // 2. Generate task plan
    const plan = await generateTaskPlan(adapter, prompt, profile);
    options.onProgress?.({ type: 'plan-ready', message: `Plan: ${plan.goal} (${plan.subtasks.length} subtasks)` });

    // 3. Estimate token cost
    const _estimatedCost = estimateTokenCost(plan);

    // 4. Set up infrastructure
    const pool = new ProviderPool(adapter, options.maxWorkers);
    const fileLock = new FileLockManager();

    // Assign file ownership from plan
    for (const subtask of plan.subtasks) {
      fileLock.assignOwnership(subtask.id, subtask.files);
    }

    // 5. Walk dependency graph topologically
    const order = topologicalSort(plan.dependencyGraph);
    const results: WorkerResult[] = [];
    const completedSummaries = new Map<string, string>(); // subtaskId -> summary

    // Track round estimates for adaptive adjustment
    const _estimateDrift = 1.0; // multiplier

    // 6. Dispatch workers respecting dependencies
    for (const subtaskId of order) {
      if (signal.aborted) break;

      const subtask = plan.subtasks.find(s => s.id === subtaskId);
      if (!subtask) continue;

      // Build context from completed dependencies
      const deps = plan.dependencyGraph.get(subtaskId) ?? [];
      const priorSummaries = deps
        .map(d => completedSummaries.get(d))
        .filter(Boolean)
        .join('\n');
      const priorFiles = results
        .filter(r => deps.includes(r.subtaskId))
        .flatMap(r => r.filesChanged.map(f => f.path));

      const context = {
        priorSummary: priorSummaries,
        filesAvailable: priorFiles,
        planReminder: `You are on subtask ${subtask.id} of ${plan.subtasks.length}: ${subtask.description}`,
      };

      options.onProgress?.({ type: 'worker-started', subtaskId, message: `Starting: ${subtask.description}` });

      // Acquire provider lease
      const lease = await pool.acquire();

      try {
        const result = await executeWorker(subtask, context, signal, {
          lease,
          workspaceRoot,
          workspaceProfile: profile,
          toolSchemas,
          executeTool,
        });

        // Track token usage
        pool.addTokenUsage(result.tokensUsed);

        if (result.status === 'completed') {
          completedSummaries.set(subtaskId, result.summary);
          options.onProgress?.({ type: 'worker-completed', subtaskId, message: `Done: ${subtask.description}` });
        } else if (result.status === 'failed') {
          // Retry once
          options.onProgress?.({ type: 'worker-failed', subtaskId, message: `Failed: ${result.error}. Retrying...` });
          const retryResult = await executeWorker(subtask, context, signal, {
            lease,
            workspaceRoot,
            workspaceProfile: profile,
            toolSchemas,
            executeTool,
          });
          pool.addTokenUsage(retryResult.tokensUsed);
          results.push(retryResult);
          if (retryResult.status === 'completed') {
            completedSummaries.set(subtaskId, retryResult.summary);
          }
          lease.release();
          continue;
        }

        results.push(result);
      } finally {
        lease.release();
        fileLock.releaseAll(subtaskId);
      }
    }

    // 7. Build summary
    const totalTokens = pool.getTotalTokens();
    const allFiles = results.flatMap(r => r.filesChanged.map(f => f.path));
    const uniqueFiles = [...new Set(allFiles)];

    const summary = results
      .map(r => `- ${r.subtaskId}: ${r.status} — ${r.summary}`)
      .join('\n');

    options.onProgress?.({ type: 'all-done', message: `Completed ${results.filter(r => r.status === 'completed').length}/${plan.subtasks.length} subtasks` });

    return { plan, results, totalTokens, filesChanged: uniqueFiles, summary };
  }
}
