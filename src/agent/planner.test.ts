import { describe, it, expect, vi } from 'vitest';
import { generateTaskPlan, estimateTokenCost } from './planner.js';
import type { WorkspaceProfile, TaskPlan } from './types.js';

const mockProfile: WorkspaceProfile = {
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
};

// Mock adapter that returns a valid plan JSON
const makeAdapter = (responseContent: string) => ({
  info: { name: 'mock', supportsStreaming: true, supportsTools: true },
  validateCredentials: vi.fn(),
  streamCompletion: vi.fn(),
  listModels: vi.fn(),
  chatWithTools: vi.fn().mockResolvedValue({
    content: responseContent,
    toolCalls: [],
  }),
} as any);

describe('generateTaskPlan', () => {
  it('parses a valid single-subtask plan', async () => {
    const json = JSON.stringify({
      goal: 'Fix the auth bug',
      subtasks: [{
        id: '1', description: 'Fix login validation',
        files: [{ path: 'src/auth.ts', mode: 'modify' }],
        estimatedRounds: 10,
      }],
      dependencies: {},
    });
    const adapter = makeAdapter(json);
    const plan = await generateTaskPlan(adapter, 'fix auth bug', mockProfile);
    expect(plan.goal).toBe('Fix the auth bug');
    expect(plan.subtasks).toHaveLength(1);
    expect(plan.subtasks[0].id).toBe('1');
  });

  it('parses JSON wrapped in code fences', async () => {
    const json = '```json\n' + JSON.stringify({
      goal: 'Add feature',
      subtasks: [{ id: '1', description: 'Do thing', files: [], estimatedRounds: 5 }],
      dependencies: {},
    }) + '\n```';
    const adapter = makeAdapter(json);
    const plan = await generateTaskPlan(adapter, 'add feature', mockProfile);
    expect(plan.subtasks).toHaveLength(1);
  });

  it('parses multi-subtask plan with dependencies', async () => {
    const json = JSON.stringify({
      goal: 'Add user API',
      subtasks: [
        { id: '1', description: 'Create model', files: [{ path: 'src/model.ts', mode: 'create' }], estimatedRounds: 8 },
        { id: '2', description: 'Create routes', files: [{ path: 'src/routes.ts', mode: 'create' }], estimatedRounds: 12 },
        { id: '3', description: 'Write tests', files: [{ path: 'src/routes.test.ts', mode: 'create' }], estimatedRounds: 10 },
      ],
      dependencies: { '2': ['1'], '3': ['2'] },
    });
    const adapter = makeAdapter(json);
    const plan = await generateTaskPlan(adapter, 'add user API', mockProfile);
    expect(plan.subtasks).toHaveLength(3);
    expect(plan.dependencyGraph.get('2')).toEqual(['1']);
    expect(plan.dependencyGraph.get('3')).toEqual(['2']);
  });

  it('throws AGENT_PLAN_FAILED on empty response', async () => {
    const adapter = makeAdapter('');
    // chatWithTools returns empty content
    adapter.chatWithTools.mockResolvedValue({ content: '', toolCalls: [] });
    await expect(generateTaskPlan(adapter, 'test', mockProfile)).rejects.toThrow('AGENT_PLAN_FAILED');
  });

  it('throws AGENT_PLAN_FAILED on invalid JSON', async () => {
    const adapter = makeAdapter('not json at all');
    await expect(generateTaskPlan(adapter, 'test', mockProfile)).rejects.toThrow();
  });

  it('throws AGENT_PLAN_CYCLE on cyclic dependencies', async () => {
    const json = JSON.stringify({
      goal: 'Cyclic',
      subtasks: [
        { id: '1', description: 'A', files: [], estimatedRounds: 5 },
        { id: '2', description: 'B', files: [], estimatedRounds: 5 },
      ],
      dependencies: { '1': ['2'], '2': ['1'] },
    });
    const adapter = makeAdapter(json);
    await expect(generateTaskPlan(adapter, 'test', mockProfile)).rejects.toThrow('AGENT_PLAN_CYCLE');
  });
});

describe('estimateTokenCost', () => {
  it('estimates based on total rounds', () => {
    const plan: TaskPlan = {
      goal: 'test',
      subtasks: [
        { id: '1', description: '', files: [], estimatedRounds: 10 },
        { id: '2', description: '', files: [], estimatedRounds: 15 },
      ],
      dependencyGraph: new Map([['1', []], ['2', ['1']]]),
    };
    expect(estimateTokenCost(plan)).toBe(25000); // 25 rounds * 1000
  });
});
