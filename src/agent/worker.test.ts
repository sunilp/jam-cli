import { describe, it, expect, vi } from 'vitest';
import { executeWorker } from './worker.js';
import type { WorkspaceProfile, Subtask, SubtaskContext } from './types.js';
import type { ProviderAdapter, ChatWithToolsResponse } from '../providers/base.js';

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

const subtask: Subtask = {
  id: '1',
  description: 'Create hello.ts',
  files: [{ path: 'src/hello.ts', mode: 'create' }],
  estimatedRounds: 5,
};

const context: SubtaskContext = {
  priorSummary: '',
  filesAvailable: [],
  planReminder: '',
};

function makeMockAdapter(responses: Array<Partial<ChatWithToolsResponse>>) {
  let callIndex = 0;
  return {
    info: { name: 'mock', supportsStreaming: true, supportsTools: true },
    validateCredentials: vi.fn(),
    streamCompletion: vi.fn(),
    listModels: vi.fn(),
    chatWithTools: vi.fn().mockImplementation(() => {
      const resp = responses[callIndex] ?? { content: 'Done', toolCalls: [] };
      callIndex++;
      return Promise.resolve({ ...resp, usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } });
    }),
  } as unknown as ProviderAdapter;
}

describe('executeWorker', () => {
  it('completes a subtask with tool calls', async () => {
    const adapter = makeMockAdapter([
      { content: 'Writing file', toolCalls: [{ name: 'write_file', arguments: { path: 'src/hello.ts', content: 'export const hello = 1;' } }] },
      { content: 'Done creating the file', toolCalls: [] },
    ]);
    const executeTool = vi.fn().mockResolvedValue('File written');
    const result = await executeWorker(subtask, context, AbortSignal.timeout(5000), {
      lease: { adapter, release: vi.fn() },
      workspaceRoot: '/workspace',
      workspaceProfile: mockProfile,
      toolSchemas: [],
      executeTool,
    });
    expect(result.status).toBe('completed');
    expect(result.subtaskId).toBe('1');
    expect(result.tokensUsed.totalTokens).toBeGreaterThan(0);
    expect(executeTool).toHaveBeenCalledWith('write_file', expect.objectContaining({ path: 'src/hello.ts' }));
  });

  it('returns cancelled on abort signal', async () => {
    const controller = new AbortController();
    controller.abort(); // abort immediately
    const adapter = makeMockAdapter([]);
    const result = await executeWorker(subtask, context, controller.signal, {
      lease: { adapter, release: vi.fn() },
      workspaceRoot: '/workspace',
      workspaceProfile: mockProfile,
      toolSchemas: [],
      executeTool: vi.fn(),
    });
    expect(result.status).toBe('cancelled');
  });

  it('fails when exceeding round budget', async () => {
    // Always return tool calls — never completes
    const adapter = makeMockAdapter(
      Array<Partial<ChatWithToolsResponse>>(15).fill({ content: 'Reading', toolCalls: [{ name: 'read_file', arguments: { path: 'src/a.ts' } }] }),
    );
    const subtaskShort = { ...subtask, estimatedRounds: 3 };
    const result = await executeWorker(subtaskShort, context, AbortSignal.timeout(5000), {
      lease: { adapter, release: vi.fn() },
      workspaceRoot: '/workspace',
      workspaceProfile: mockProfile,
      toolSchemas: [],
      executeTool: vi.fn().mockResolvedValue('file content'),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('TIMEOUT');
  });

  it('handles tool execution errors gracefully', async () => {
    const adapter = makeMockAdapter([
      { content: 'Trying', toolCalls: [{ name: 'read_file', arguments: { path: 'bad.ts' } }] },
      { content: 'Done', toolCalls: [] },
    ]);
    const executeTool = vi.fn().mockRejectedValueOnce(new Error('file not found'));
    const result = await executeWorker(subtask, context, AbortSignal.timeout(5000), {
      lease: { adapter, release: vi.fn() },
      workspaceRoot: '/workspace',
      workspaceProfile: mockProfile,
      toolSchemas: [],
      executeTool,
    });
    expect(result.status).toBe('completed');
  });

  it('fails when provider lacks tool support', async () => {
    const adapter = {
      info: { name: 'mock', supportsStreaming: true },
      validateCredentials: vi.fn(),
      streamCompletion: vi.fn(),
      listModels: vi.fn(),
      // NO chatWithTools
    } as unknown as ProviderAdapter;
    const result = await executeWorker(subtask, context, AbortSignal.timeout(5000), {
      lease: { adapter, release: vi.fn() },
      workspaceRoot: '/workspace',
      workspaceProfile: mockProfile,
      toolSchemas: [],
      executeTool: vi.fn(),
    });
    expect(result.status).toBe('failed');
  });

  it('tracks file changes from write_file calls', async () => {
    const adapter = makeMockAdapter([
      { content: 'Writing', toolCalls: [{ name: 'write_file', arguments: { path: 'src/a.ts', content: 'code' } }] },
      { content: 'Writing more', toolCalls: [{ name: 'write_file', arguments: { path: 'src/b.ts', content: 'code' } }] },
      { content: 'Done', toolCalls: [] },
    ]);
    const result = await executeWorker(subtask, context, AbortSignal.timeout(5000), {
      lease: { adapter, release: vi.fn() },
      workspaceRoot: '/workspace',
      workspaceProfile: mockProfile,
      toolSchemas: [],
      executeTool: vi.fn().mockResolvedValue('ok'),
    });
    expect(result.filesChanged).toHaveLength(2);
    expect(result.filesChanged[0].path).toBe('src/a.ts');
    expect(result.filesChanged[1].path).toBe('src/b.ts');
  });

  it('runs validation command on completion', async () => {
    const subtaskWithValidation: Subtask = {
      ...subtask,
      validationCommand: 'npm test',
    };
    const adapter = makeMockAdapter([
      { content: 'Done', toolCalls: [] },
    ]);
    const executeTool = vi.fn().mockResolvedValue('ok');
    const result = await executeWorker(subtaskWithValidation, context, AbortSignal.timeout(5000), {
      lease: { adapter, release: vi.fn() },
      workspaceRoot: '/workspace',
      workspaceProfile: mockProfile,
      toolSchemas: [],
      executeTool,
    });
    expect(result.status).toBe('completed');
    expect(executeTool).toHaveBeenCalledWith('run_command', { command: 'npm test' });
  });

  it('completes even when validation command fails', async () => {
    const subtaskWithValidation: Subtask = {
      ...subtask,
      validationCommand: 'npm test',
    };
    const adapter = makeMockAdapter([
      { content: 'Done', toolCalls: [] },
    ]);
    const executeTool = vi.fn().mockRejectedValue(new Error('tests failed'));
    const result = await executeWorker(subtaskWithValidation, context, AbortSignal.timeout(5000), {
      lease: { adapter, release: vi.fn() },
      workspaceRoot: '/workspace',
      workspaceProfile: mockProfile,
      toolSchemas: [],
      executeTool,
    });
    expect(result.status).toBe('completed');
  });

  it('includes prior context in initial prompt', async () => {
    const contextWithPrior: SubtaskContext = {
      priorSummary: 'Created the model file',
      filesAvailable: ['src/model.ts'],
      planReminder: 'Remember to use barrel exports',
    };
    const adapter = makeMockAdapter([
      { content: 'Done', toolCalls: [] },
    ]);
    await executeWorker(subtask, contextWithPrior, AbortSignal.timeout(5000), {
      lease: { adapter, release: vi.fn() },
      workspaceRoot: '/workspace',
      workspaceProfile: mockProfile,
      toolSchemas: [],
      executeTool: vi.fn(),
    });
    // Verify the initial message included context
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockChatWithTools = adapter.chatWithTools as unknown as { mock: { calls: Array<Array<Array<{ content: string }>>> } };
    const firstCall = mockChatWithTools.mock.calls[0];
    const messages = firstCall[0];
    expect(messages[0].content).toContain('Created the model file');
    expect(messages[0].content).toContain('src/model.ts');
    expect(messages[0].content).toContain('barrel exports');
  });

  it('accumulates token usage across rounds', async () => {
    const adapter = makeMockAdapter([
      { content: 'Reading', toolCalls: [{ name: 'read_file', arguments: { path: 'src/a.ts' } }] },
      { content: 'Writing', toolCalls: [{ name: 'write_file', arguments: { path: 'src/b.ts', content: 'x' } }] },
      { content: 'Done', toolCalls: [] },
    ]);
    const result = await executeWorker(subtask, context, AbortSignal.timeout(5000), {
      lease: { adapter, release: vi.fn() },
      workspaceRoot: '/workspace',
      workspaceProfile: mockProfile,
      toolSchemas: [],
      executeTool: vi.fn().mockResolvedValue('ok'),
    });
    // 3 rounds * 150 tokens each = 450
    expect(result.tokensUsed.totalTokens).toBe(450);
    expect(result.tokensUsed.promptTokens).toBe(300);
    expect(result.tokensUsed.completionTokens).toBe(150);
  });
});
