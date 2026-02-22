import { describe, it, expect } from 'vitest';
import { runCommandTool } from './run_command.js';
import { JamError } from '../utils/errors.js';
import type { ToolContext } from './types.js';

const ctx: ToolContext = { workspaceRoot: process.cwd(), cwd: process.cwd() };

describe('runCommandTool', () => {
  it('is a write tool (readonly: false)', () => {
    expect(runCommandTool.readonly).toBe(false);
  });

  it('captures stdout from a successful command', async () => {
    const result = await runCommandTool.execute({ command: 'echo', args: 'hello world' }, ctx);
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('hello world');
  });

  it('captures stderr and includes it in output', async () => {
    // process.stderr.write('err') has no spaces so it stays as a single arg after split
    const result = await runCommandTool.execute(
      { command: 'node', args: "-e process.stderr.write('err')" },
      ctx
    );
    expect(result.output).toContain('[stderr]');
  });

  it('returns error output for non-zero exit code', async () => {
    // Without shell quoting: node receives ['-e', 'process.exit(1)'] directly
    const result = await runCommandTool.execute({ command: 'node', args: '-e process.exit(1)' }, ctx);
    expect(result.error).toBeTruthy();
  });

  it('throws INPUT_MISSING when command is empty', async () => {
    await expect(
      runCommandTool.execute({ command: '' }, ctx)
    ).rejects.toSatisfy((err: unknown) => {
      return JamError.isJamError(err) && err.code === 'INPUT_MISSING';
    });
  });

  it('throws INPUT_MISSING when command is missing', async () => {
    await expect(
      runCommandTool.execute({}, ctx)
    ).rejects.toSatisfy((err: unknown) => {
      return JamError.isJamError(err) && err.code === 'INPUT_MISSING';
    });
  });

  it('blocks dangerous commands: rm -rf', async () => {
    await expect(
      runCommandTool.execute({ command: 'rm', args: '-rf /' }, ctx)
    ).rejects.toSatisfy((err: unknown) => {
      return JamError.isJamError(err) && err.code === 'TOOL_DENIED';
    });
  });

  it('blocks sudo commands', async () => {
    await expect(
      runCommandTool.execute({ command: 'sudo', args: 'apt-get install vim' }, ctx)
    ).rejects.toSatisfy((err: unknown) => {
      return JamError.isJamError(err) && err.code === 'TOOL_DENIED';
    });
  });

  it('blocks shutdown commands', async () => {
    await expect(
      runCommandTool.execute({ command: 'shutdown', args: '-h now' }, ctx)
    ).rejects.toSatisfy((err: unknown) => {
      return JamError.isJamError(err) && err.code === 'TOOL_DENIED';
    });
  });

  it('returns (no output) when command produces no output', async () => {
    const result = await runCommandTool.execute({ command: 'true' }, ctx);
    expect(result.output).toBe('(no output)');
  });

  it('passes timeout argument (uses seconds)', async () => {
    // A command that finishes quickly — just verify it works with a custom timeout
    const result = await runCommandTool.execute({ command: 'echo', args: 'quick', timeout: 5 }, ctx);
    expect(result.output).toContain('quick');
  });
});
