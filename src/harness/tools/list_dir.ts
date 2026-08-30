import { z } from 'zod';
import { safePath, fsError } from './types.js';
import type { Tool } from './types.js';
import type { DirEntry } from '../world/types.js';

const input = z.object({
  path: z.string().describe('Directory relative to the workspace root.'),
});

export const listDirTool: Tool<z.infer<typeof input>, { entries: DirEntry[] }> = {
  name: 'list_dir',
  description: 'List the entries of a directory.',
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
    if (!info?.isDir) {
      return { ok: false, error: {
        type: 'not_found', recoverable: true, message: `No such directory: ${args.path}`,
      } };
    }
    try {
      return { ok: true, value: { entries: await ctx.world.fs.list(abs) } };
    } catch (err) {
      return { ok: false, error: fsError(err, args.path) };
    }
  },
};
