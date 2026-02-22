import { readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { resolve } from 'node:path';
import { JamError } from '../utils/errors.js';
import type { ToolDefinition, ToolContext, ToolResult } from './types.js';

export const listDirTool: ToolDefinition = {
  name: 'list_dir',
  description: 'List the contents of a directory. Directories are shown with a trailing /.',
  readonly: true,
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the directory, relative to workspace root. Defaults to ".".',
        optional: true,
      },
    },
    required: [],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const dirPath = typeof args['path'] === 'string' ? args['path'] : '.';
    const absolutePath = resolve(ctx.workspaceRoot, dirPath);

    let entries: Dirent[];
    try {
      entries = await readdir(absolutePath, { withFileTypes: true });
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        throw new JamError(
          `Directory not found: ${dirPath}`,
          'INPUT_FILE_NOT_FOUND',
          { cause: err }
        );
      }
      throw new JamError(
        `Failed to list directory: ${dirPath}`,
        'TOOL_EXEC_ERROR',
        { cause: err }
      );
    }

    const dirs: string[] = [];
    const files: string[] = [];

    for (const entry of entries) {
      const name = String(entry.name);
      if (entry.isDirectory()) {
        dirs.push(`${name}/`);
      } else {
        files.push(name);
      }
    }

    dirs.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.localeCompare(b));

    const allEntries = [...dirs, ...files];

    const output =
      allEntries.length === 0
        ? '(empty directory)'
        : allEntries.join('\n');

    return {
      output,
      metadata: {
        path: absolutePath,
        totalEntries: allEntries.length,
        directoryCount: dirs.length,
        fileCount: files.length,
      },
    };
  },
};
