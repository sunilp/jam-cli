import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { JamError } from '../utils/errors.js';
import type { ToolDefinition, ToolContext, ToolResult } from './types.js';

export const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    'Write or append content to a file. Creates parent directories if they do not exist.',
  readonly: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file, relative to workspace root.' },
      content: { type: 'string', description: 'Content to write to the file.' },
      mode: {
        type: 'string',
        description: '"overwrite" (default) replaces the file; "append" adds to the end.',
        optional: true,
      },
    },
    required: ['path', 'content'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = args['path'];
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      throw new JamError('Argument "path" must be a non-empty string.', 'INPUT_MISSING');
    }

    const content = args['content'];
    if (typeof content !== 'string') {
      throw new JamError('Argument "content" must be a string.', 'INPUT_MISSING');
    }

    const mode = args['mode'] === 'append' ? 'append' : 'overwrite';
    const absolutePath = resolve(ctx.workspaceRoot, filePath);
    const parentDir = dirname(absolutePath);

    try {
      await mkdir(parentDir, { recursive: true });
    } catch (err) {
      throw new JamError(
        `Failed to create parent directories for: ${filePath}`,
        'TOOL_EXEC_ERROR',
        { cause: err }
      );
    }

    const byteLength = Buffer.byteLength(content, 'utf8');

    try {
      if (mode === 'append') {
        await appendFile(absolutePath, content, 'utf8');
      } else {
        await writeFile(absolutePath, content, 'utf8');
      }
    } catch (err) {
      throw new JamError(
        `Failed to write file: ${filePath}`,
        'TOOL_EXEC_ERROR',
        { cause: err }
      );
    }

    return {
      output: `Written ${byteLength} bytes to ${filePath}`,
      metadata: {
        path: absolutePath,
        mode,
        bytes: byteLength,
      },
    };
  },
};
