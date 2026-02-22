/* eslint-disable @typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JamError } from '../utils/errors.js';
import type { ToolDefinition, ToolContext, ToolResult } from './types.js';

// ---------------------------------------------------------------------------
// Mock node:readline/promises at the top level so Vitest can hoist it.
// We control the answer returned per-test via `mockQuestion`.
// ---------------------------------------------------------------------------
const mockClose = vi.fn();
const mockQuestion = vi.fn<() => Promise<string>>();

vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: mockQuestion,
    close: mockClose,
  }),
}));

// Import registry AFTER the mock is set up
const { ToolRegistry } = await import('./registry.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReadonlyTool(name = 'mock_readonly'): ToolDefinition {
  return {
    name,
    description: 'A mock read-only tool for testing.',
    readonly: true,
    parameters: { type: 'object', properties: {}, required: [] },
    execute: vi.fn().mockResolvedValue({ output: 'readonly result' } satisfies ToolResult),
  };
}

function makeWriteTool(name = 'mock_write'): ToolDefinition {
  return {
    name,
    description: 'A mock write tool for testing.',
    readonly: false,
    parameters: { type: 'object', properties: {}, required: [] },
    execute: vi.fn().mockResolvedValue({ output: 'write result' } satisfies ToolResult),
  };
}

const ctx: ToolContext = {
  workspaceRoot: '/tmp/test-workspace',
  cwd: '/tmp/test-workspace',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolRegistry', () => {
  let registry: InstanceType<typeof ToolRegistry>;

  beforeEach(() => {
    registry = new ToolRegistry();
    mockQuestion.mockReset();
    mockClose.mockReset();
  });

  // ---- register / get / list ----

  it('registers and retrieves a tool by name', () => {
    const tool = makeReadonlyTool();
    registry.register(tool);
    expect(registry.get(tool.name)).toBe(tool);
  });

  it('returns undefined for an unknown tool name', () => {
    expect(registry.get('does_not_exist')).toBeUndefined();
  });

  it('lists all registered tools', () => {
    const a = makeReadonlyTool('tool_a');
    const b = makeWriteTool('tool_b');
    registry.register(a);
    registry.register(b);
    const listed = registry.list();
    expect(listed).toHaveLength(2);
    expect(listed).toContain(a);
    expect(listed).toContain(b);
  });

  // ---- tool not found ----

  it('throws TOOL_NOT_FOUND when executing an unregistered tool', async () => {
    await expect(
      registry.execute('missing_tool', {}, ctx, 'allowlist')
    ).rejects.toSatisfy((err: unknown) => {
      return JamError.isJamError(err) && err.code === 'TOOL_NOT_FOUND';
    });
  });

  // ---- readonly tools ----

  it('executes a readonly tool without prompting (allowlist policy)', async () => {
    const tool = makeReadonlyTool();
    registry.register(tool);

    const result = await registry.execute(tool.name, {}, ctx, 'allowlist');
    expect(result.output).toBe('readonly result');
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(mockQuestion).not.toHaveBeenCalled();
  });

  it('executes a readonly tool without prompting (never policy)', async () => {
    const tool = makeReadonlyTool();
    registry.register(tool);

    const result = await registry.execute(tool.name, {}, ctx, 'never');
    expect(result.output).toBe('readonly result');
    expect(mockQuestion).not.toHaveBeenCalled();
  });

  it('executes a readonly tool without prompting (ask_every_time policy)', async () => {
    const tool = makeReadonlyTool();
    registry.register(tool);

    // Should NOT show any readline prompt for readonly tools
    const result = await registry.execute(tool.name, {}, ctx, 'ask_every_time');
    expect(result.output).toBe('readonly result');
    expect(mockQuestion).not.toHaveBeenCalled();
  });

  // ---- write tools: never policy ----

  it('throws TOOL_DENIED for a write tool when policy is "never"', async () => {
    const tool = makeWriteTool();
    registry.register(tool);

    await expect(
      registry.execute(tool.name, {}, ctx, 'never')
    ).rejects.toSatisfy((err: unknown) => {
      return JamError.isJamError(err) && err.code === 'TOOL_DENIED';
    });

    expect(tool.execute).not.toHaveBeenCalled();
    expect(mockQuestion).not.toHaveBeenCalled();
  });

  // ---- write tools: allowlist policy ----

  it('executes a write tool without prompting when policy is "allowlist"', async () => {
    const tool = makeWriteTool();
    registry.register(tool);

    const result = await registry.execute(tool.name, {}, ctx, 'allowlist');
    expect(result.output).toBe('write result');
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(mockQuestion).not.toHaveBeenCalled();
  });

  // ---- write tools: ask_every_time policy ----

  it('denies a write tool when the user answers "N" (ask_every_time policy)', async () => {
    const tool = makeWriteTool();
    registry.register(tool);

    mockQuestion.mockResolvedValue('N');

    await expect(
      registry.execute(tool.name, {}, ctx, 'ask_every_time')
    ).rejects.toSatisfy((err: unknown) => {
      return JamError.isJamError(err) && err.code === 'TOOL_DENIED';
    });

    expect(mockQuestion).toHaveBeenCalledOnce();
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('denies a write tool when the user presses Enter with no input (ask_every_time policy)', async () => {
    const tool = makeWriteTool();
    registry.register(tool);

    mockQuestion.mockResolvedValue('');

    await expect(
      registry.execute(tool.name, {}, ctx, 'ask_every_time')
    ).rejects.toSatisfy((err: unknown) => {
      return JamError.isJamError(err) && err.code === 'TOOL_DENIED';
    });
  });

  it('allows a write tool when the user answers "y" (ask_every_time policy)', async () => {
    const tool = makeWriteTool();
    registry.register(tool);

    mockQuestion.mockResolvedValue('y');

    const result = await registry.execute(tool.name, {}, ctx, 'ask_every_time');
    expect(result.output).toBe('write result');
    expect(mockQuestion).toHaveBeenCalledOnce();
  });

  it('closes the readline interface after confirmation regardless of answer', async () => {
    const tool = makeWriteTool();
    registry.register(tool);

    mockQuestion.mockResolvedValue('N');

    await expect(
      registry.execute(tool.name, {}, ctx, 'ask_every_time')
    ).rejects.toBeDefined();

    expect(mockClose).toHaveBeenCalledOnce();
  });

  // ---- error propagation ----

  it('re-throws JamErrors thrown by a tool execute function', async () => {
    const tool: ToolDefinition = {
      ...makeReadonlyTool('error_tool'),
      execute: vi.fn().mockRejectedValue(
        new JamError('Something went wrong', 'TOOL_EXEC_ERROR')
      ),
    };
    registry.register(tool);

    await expect(
      registry.execute(tool.name, {}, ctx, 'allowlist')
    ).rejects.toSatisfy((err: unknown) => {
      return JamError.isJamError(err) && err.code === 'TOOL_EXEC_ERROR';
    });
  });

  it('wraps non-JamErrors from a tool execute function as TOOL_EXEC_ERROR', async () => {
    const tool: ToolDefinition = {
      ...makeReadonlyTool('crash_tool'),
      execute: vi.fn().mockRejectedValue(new Error('unexpected')),
    };
    registry.register(tool);

    await expect(
      registry.execute(tool.name, {}, ctx, 'allowlist')
    ).rejects.toSatisfy((err: unknown) => {
      return JamError.isJamError(err) && err.code === 'TOOL_EXEC_ERROR';
    });
  });

  // ---- happy path with args ----

  it('passes args and ctx through to the tool execute function', async () => {
    const tool = makeReadonlyTool('args_tool');
    registry.register(tool);
    const args = { foo: 'bar', count: 3 };

    await registry.execute(tool.name, args, ctx, 'allowlist');

    expect(tool.execute).toHaveBeenCalledWith(args, ctx);
  });
});
