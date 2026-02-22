import { JamError } from '../utils/errors.js';
import type { ToolDefinition, ToolContext, ToolResult } from './types.js';
import { runCommand } from './run_command.js';

export const gitStatusTool: ToolDefinition = {
  name: 'git_status',
  description: 'Show the short git status of the workspace.',
  readonly: true,
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },

  async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    let stdout: string;
    try {
      stdout = await runCommand('git', ['status', '--short'], ctx.workspaceRoot);
    } catch (err: unknown) {
      throw new JamError(
        'git status failed. Is this a git repository?',
        'TOOL_EXEC_ERROR',
        { cause: err }
      );
    }

    const output = stdout.trim();

    return {
      output: output === '' ? 'No changes (working tree clean).' : output,
    };
  },
};
