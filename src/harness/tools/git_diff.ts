import { z } from 'zod';
import { preview } from '../artifacts.js';
import type { Tool } from './types.js';

const input = z.object({
  staged: z.boolean().optional().describe('Show staged changes instead of the working tree.'),
});

export const gitDiffTool: Tool<z.infer<typeof input>, { diff: string }> = {
  name: 'git_diff',
  description: 'Show the current diff of the workspace.',
  input,
  risk: 'R0',
  mutates: false,
  async execute(args, ctx) {
    const argv = ['diff'];
    if (args.staged === true) argv.push('--staged');

    const r = await ctx.world.subprocess.run({
      command: 'git', args: argv, cwd: ctx.workspaceRoot,
      timeoutMs: 30_000, signal: ctx.signal, callId: ctx.callId,
    });
    if (r.exitCode !== 0) {
      return { ok: false, error: {
        type: 'internal', recoverable: true, message: r.stderr.trim() || 'git diff failed',
      } };
    }
    const artifact = ctx.artifacts.put(r.stdout);
    return { ok: true, value: { diff: preview(r.stdout) }, artifact };
  },
};
