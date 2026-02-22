import { JamError } from '../utils/errors.js';
import type { ToolDefinition, ToolContext, ToolResult } from './types.js';
import { runCommand } from './run_command.js';

export const gitDiffTool: ToolDefinition = {
  name: 'git_diff',
  description: 'Show git diff for the workspace, optionally for staged changes or a specific path.',
  readonly: true,
  parameters: {
    type: 'object',
    properties: {
      staged: {
        type: 'boolean',
        description: 'If true, show staged (cached) changes. Defaults to false.',
        optional: true,
      },
      path: {
        type: 'string',
        description: 'Optional file path to limit the diff.',
        optional: true,
      },
    },
    required: [],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const gitArgs = ['diff'];

    if (args['staged'] === true) {
      gitArgs.push('--staged');
    }

    const pathArg = args['path'];
    if (typeof pathArg === 'string' && pathArg.trim() !== '') {
      gitArgs.push('--', pathArg);
    }

    let stdout: string;
    try {
      stdout = await runCommand('git', gitArgs, ctx.workspaceRoot);
    } catch (err: unknown) {
      throw new JamError(
        'git diff failed. Is this a git repository?',
        'TOOL_EXEC_ERROR',
        { cause: err }
      );
    }

    const output = stdout.trim();

    return {
      output: output === '' ? 'No changes found.' : output,
      metadata: {
        staged: args['staged'] === true,
        path: args['path'] ?? null,
      },
    };
  },
};
