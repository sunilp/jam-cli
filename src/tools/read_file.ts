import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JamError } from '../utils/errors.js';
import type { ToolDefinition, ToolContext, ToolResult } from './types.js';

const MAX_BYTES = 500 * 1024; // 500KB

export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file, optionally limited to a line range.',
  readonly: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file, relative to workspace root.' },
      startLine: {
        type: 'number',
        description: 'First line to return (1-based, inclusive).',
        optional: true,
      },
      endLine: {
        type: 'number',
        description: 'Last line to return (1-based, inclusive).',
        optional: true,
      },
    },
    required: ['path'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const filePath = args['path'];
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      throw new JamError('Argument "path" must be a non-empty string.', 'INPUT_MISSING');
    }

    const absolutePath = resolve(ctx.workspaceRoot, filePath);

    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        throw new JamError(
          `File not found: ${filePath}`,
          'INPUT_FILE_NOT_FOUND',
          { cause: err }
        );
      }
      throw new JamError(
        `Failed to read file: ${filePath}`,
        'TOOL_EXEC_ERROR',
        { cause: err }
      );
    }

    let truncationWarning = '';
    let content: string;

    if (buffer.byteLength > MAX_BYTES) {
      const truncated = buffer.subarray(0, MAX_BYTES);
      content = truncated.toString('utf8');
      // Trim any incomplete multi-byte character at the cut boundary
      const lastNewline = content.lastIndexOf('\n');
      if (lastNewline !== -1) {
        content = content.slice(0, lastNewline + 1);
      }
      truncationWarning = `\n[WARNING: File exceeds 500KB. Only the first 500KB is shown.]\n`;
    } else {
      content = buffer.toString('utf8');
    }

    const lines = content.split('\n');

    const startLine =
      typeof args['startLine'] === 'number' ? Math.max(1, args['startLine']) : 1;
    const endLine =
      typeof args['endLine'] === 'number'
        ? Math.min(args['endLine'], lines.length)
        : lines.length;

    const selectedLines = lines.slice(startLine - 1, endLine);

    const numbered = selectedLines
      .map((line, idx) => {
        const lineNum = String(startLine + idx).padStart(6, ' ');
        return `${lineNum}\t${line}`;
      })
      .join('\n');

    const output = truncationWarning ? `${numbered}${truncationWarning}` : numbered;

    return {
      output,
      metadata: {
        path: absolutePath,
        totalLines: lines.length,
        startLine,
        endLine,
        truncated: truncationWarning !== '',
      },
    };
  },
};
