import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Orchestrator } from './orchestrator.js';
import type { ProgressEvent } from './orchestrator.js';

// Mock workspace-intel to avoid filesystem dependency
vi.mock('./workspace-intel.js', () => ({
  buildWorkspaceProfile: vi.fn().mockResolvedValue({
    language: 'typescript', monorepo: false, srcLayout: 'src/',
    entryPoints: ['src/index.ts'], codeStyle: {
      indent: 'spaces', indentSize: 2, quotes: 'single',
      semicolons: true, trailingCommas: true, namingConvention: 'camelCase',
    },
    fileNaming: 'kebab-case.ts', exportStyle: 'barrel', importStyle: 'relative',
    errorHandling: 'JamError', logging: 'Logger', configPattern: 'cosmiconfig',
    testFramework: 'vitest', testLocation: 'co-located', testNaming: '*.test.ts',
    testStyle: 'describe/it', testCommand: 'npm test', commitConvention: 'conventional',
    branchPattern: 'feat/*', packageManager: 'npm', typeChecker: 'tsc',
  }),
  formatProfileForPrompt: vi.fn().mockReturnValue('TypeScript project'),
}));

// Mock planner to return a 2-subtask plan with dependency
vi.mock('./planner.js', () => ({
  generateTaskPlan: vi.fn().mockResolvedValue({
    goal: 'Add greeting feature',
    subtasks: [
      {
        id: '1', description: 'Create greeting module',
        files: [{ path: 'src/greeting.ts', mode: 'create' }],
        estimatedRounds: 5,
      },
      {
        id: '2', description: 'Add tests for greeting',
        files: [{ path: 'src/greeting.test.ts', mode: 'create' }],
        estimatedRounds: 5,
        validationCommand: 'npm test',
      },
    ],
    dependencyGraph: new Map([['1', []], ['2', ['1']]]),
  }),
  estimateTokenCost: vi.fn().mockReturnValue(10000),
}));

// Mock worker to simulate completing subtasks
let workerCallCount = 0;
vi.mock('./worker.js', () => ({
  executeWorker: vi.fn().mockImplementation(async (subtask) => {
    workerCallCount++;
    return {
      subtaskId: subtask.id,
      status: 'completed',
      filesChanged: [{ path: subtask.files[0]?.path ?? 'unknown', action: 'created', diff: '' }],
      summary: `Completed subtask ${subtask.id}: ${subtask.description}`,
      tokensUsed: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
    };
  }),
}));

const mockAdapter = {
  info: { name: 'mock', supportsStreaming: true, supportsTools: true },
  validateCredentials: vi.fn(),
  streamCompletion: vi.fn(),
  listModels: vi.fn(),
  chatWithTools: vi.fn(),
} as any;

describe('Agent Engine Integration', () => {
  beforeEach(() => {
    workerCallCount = 0;
    vi.clearAllMocks();
  });

  it('orchestrates a 2-subtask plan end-to-end', async () => {
    const orch = new Orchestrator({
      adapter: mockAdapter,
      workspaceRoot: '/workspace',
      toolSchemas: [],
      executeTool: vi.fn().mockResolvedValue('ok'),
    });

    const events: ProgressEvent[] = [];
    const result = await orch.execute('add a greeting feature', {
      mode: 'auto',
      maxWorkers: 2,
      onProgress: (e) => events.push(e),
    });

    // Plan was generated
    expect(result.plan.goal).toBe('Add greeting feature');
    expect(result.plan.subtasks).toHaveLength(2);

    // Both subtasks completed
    expect(result.results).toHaveLength(2);
    expect(result.results.every(r => r.status === 'completed')).toBe(true);

    // Dependency order: subtask 1 before subtask 2
    expect(result.results[0].subtaskId).toBe('1');
    expect(result.results[1].subtaskId).toBe('2');

    // Files tracked
    expect(result.filesChanged).toContain('src/greeting.ts');
    expect(result.filesChanged).toContain('src/greeting.test.ts');

    // Token usage aggregated
    expect(result.totalTokens.totalTokens).toBe(600); // 300 * 2

    // Progress events fired
    expect(events.some(e => e.type === 'plan-ready')).toBe(true);
    expect(events.filter(e => e.type === 'worker-started')).toHaveLength(2);
    expect(events.filter(e => e.type === 'worker-completed')).toHaveLength(2);
    expect(events.some(e => e.type === 'all-done')).toBe(true);

    // Summary contains both subtask results
    expect(result.summary).toContain('1:');
    expect(result.summary).toContain('2:');
  });

  it('worker receives prior context from dependency', async () => {
    const { executeWorker } = await import('./worker.js');

    const orch = new Orchestrator({
      adapter: mockAdapter,
      workspaceRoot: '/workspace',
      toolSchemas: [],
      executeTool: vi.fn().mockResolvedValue('ok'),
    });

    await orch.execute('test', { mode: 'auto', maxWorkers: 1 });

    // Second worker call should have received context from first
    const calls = (executeWorker as any).mock.calls;
    expect(calls).toHaveLength(2);

    // Second call's context should reference subtask 1's output
    const secondCallContext = calls[1][1]; // context parameter
    expect(secondCallContext.priorSummary).toContain('subtask 1');
    expect(secondCallContext.filesAvailable).toContain('src/greeting.ts');
  });
});
