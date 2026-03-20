import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from './orchestrator.js';

// Mock all dependencies
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
  formatProfileForPrompt: vi.fn().mockReturnValue('Mock profile'),
}));

vi.mock('./planner.js', () => ({
  generateTaskPlan: vi.fn().mockResolvedValue({
    goal: 'Test goal',
    subtasks: [
      { id: '1', description: 'First task', files: [{ path: 'src/a.ts', mode: 'create' }], estimatedRounds: 3 },
    ],
    dependencyGraph: new Map([['1', []]]),
  }),
  estimateTokenCost: vi.fn().mockReturnValue(3000),
}));

vi.mock('./worker.js', () => ({
  executeWorker: vi.fn().mockResolvedValue({
    subtaskId: '1',
    status: 'completed',
    filesChanged: [{ path: 'src/a.ts', action: 'created', diff: '' }],
    summary: 'Created file',
    tokensUsed: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  }),
}));

const mockAdapter = {
  info: { name: 'mock', supportsStreaming: true, supportsTools: true },
  validateCredentials: vi.fn(),
  streamCompletion: vi.fn(),
  listModels: vi.fn(),
  chatWithTools: vi.fn(),
} as any;

describe('Orchestrator', () => {
  it('executes a single-subtask plan', async () => {
    const orch = new Orchestrator({
      adapter: mockAdapter,
      workspaceRoot: '/workspace',
      toolSchemas: [],
      executeTool: vi.fn(),
    });

    const result = await orch.execute('do something', {
      mode: 'auto',
      maxWorkers: 1,
    });

    expect(result.plan.goal).toBe('Test goal');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe('completed');
    expect(result.filesChanged).toContain('src/a.ts');
    expect(result.totalTokens.totalTokens).toBeGreaterThan(0);
  });

  it('calls onProgress callbacks', async () => {
    const events: string[] = [];
    const orch = new Orchestrator({
      adapter: mockAdapter,
      workspaceRoot: '/workspace',
      toolSchemas: [],
      executeTool: vi.fn(),
    });

    await orch.execute('do something', {
      mode: 'auto',
      maxWorkers: 1,
      onProgress: (e) => events.push(e.type),
    });

    expect(events).toContain('plan-ready');
    expect(events).toContain('worker-started');
    expect(events).toContain('worker-completed');
    expect(events).toContain('all-done');
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const orch = new Orchestrator({
      adapter: mockAdapter,
      workspaceRoot: '/workspace',
      toolSchemas: [],
      executeTool: vi.fn(),
    });

    const result = await orch.execute('do something', {
      mode: 'auto',
      maxWorkers: 1,
      signal: controller.signal,
    });

    // Should complete without executing workers (aborted before dispatch)
    expect(result.results).toHaveLength(0);
  });

  it('generates a summary string', async () => {
    const orch = new Orchestrator({
      adapter: mockAdapter,
      workspaceRoot: '/workspace',
      toolSchemas: [],
      executeTool: vi.fn(),
    });

    const result = await orch.execute('do something', { mode: 'auto', maxWorkers: 1 });
    expect(result.summary).toContain('1:');
    expect(result.summary).toContain('completed');
  });
});
