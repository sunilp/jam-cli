import { z } from 'zod';
import { safePath } from './types.js';
import type { Tool } from './types.js';

const MAX_BYTES = 500 * 1024;

const input = z.object({
  path: z.string().describe('Path to the file, relative to the workspace root.'),
  startLine: z.number().int().positive().optional().describe('First line, 1-based inclusive.'),
  endLine: z.number().int().positive().optional().describe('Last line, 1-based inclusive.'),
});

export const readFileTool: Tool<z.infer<typeof input>, { content: string; truncated: boolean }> = {
  name: 'read_file',
  description: 'Read a file, optionally limited to a line range.',
  input,
  risk: 'R0',
  mutates: false,
  async execute(args, ctx) {
    let abs: string;
    try {
      abs = await safePath(ctx.world, ctx.workspaceRoot, args.path);
    } catch (err) {
      return { ok: false, error: {
        type: 'sandbox.denied', recoverable: false,
        message: err instanceof Error ? err.message : String(err),
      } };
    }

    const info = await ctx.world.fs.stat(abs);
    if (!info?.isFile) {
      return { ok: false, error: {
        type: 'not_found', recoverable: true, message: `No such file: ${args.path}`,
      } };
    }

    let content = await ctx.world.fs.readFile(abs);
    let truncated = false;
    if (Buffer.byteLength(content) > MAX_BYTES) {
      content = content.slice(0, MAX_BYTES);
      truncated = true;
    }

    if (args.startLine !== undefined || args.endLine !== undefined) {
      const lines = content.split('\n');
      const from = (args.startLine ?? 1) - 1;
      const to = args.endLine ?? lines.length;
      content = lines.slice(from, to).join('\n');
    }

    return { ok: true, value: { content, truncated } };
  },
};
