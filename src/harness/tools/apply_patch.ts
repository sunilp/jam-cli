import { z } from 'zod';
import { join } from 'node:path';
import type { Tool } from './types.js';

const input = z.object({
  patch: z.string().describe('A unified diff to apply to the workspace.'),
});

export const applyPatchTool: Tool<z.infer<typeof input>, { changedFiles: string[] }> = {
  name: 'apply_patch',
  description:
    'Apply a unified diff to the workspace. This is the only way to modify files. ' +
    'The patch is validated before anything is written.',
  input,
  risk: 'R1',
  mutates: true,
  async execute(args, ctx) {
    if (args.patch.trim() === '') {
      return { ok: false, error: {
        type: 'invalid_input', recoverable: true, message: 'patch must not be empty',
      } };
    }

    const dir = await ctx.world.fs.mkdtemp('jam-patch-');
    const file = join(dir, 'patch.diff');
    await ctx.world.fs.writeFile(file, args.patch);

    const git = (argv: string[]) => ctx.world.subprocess.run({
      command: 'git', args: argv, cwd: ctx.workspaceRoot,
      timeoutMs: 60_000, signal: ctx.signal, callId: ctx.callId,
    });

    // Validate first so a bad patch never half-applies.
    const check = await git(['apply', '--check', file]);
    if (check.exitCode !== 0) {
      return { ok: false, error: {
        type: 'patch.conflict', recoverable: true,
        message: check.stderr.trim() || 'patch does not apply cleanly',
        details: { stderr: check.stderr },
      } };
    }

    const names = await git(['apply', '--numstat', '--summary', file]);
    const applied = await git(['apply', file]);
    if (applied.exitCode !== 0) {
      return { ok: false, error: {
        type: 'patch.conflict', recoverable: true,
        message: applied.stderr.trim() || 'patch failed to apply',
      } };
    }

    // numstat prints "3\t1\tpath" for text and "-\t-\tpath" for BINARY files.
    // A digits-only pattern silently drops binary changes, so git apply writes
    // the file while no file.modified event is emitted -- an unlogged mutation,
    // and no checkpoint id ever gets stamped for it.
    const changedFiles = names.stdout
      .split('\n')
      .map((l) => /^(?:-|\d+)\t(?:-|\d+)\t(.+)$/.exec(l)?.[1])
      .filter((p): p is string => p !== undefined);

    for (const path of changedFiles) {
      ctx.emit({ type: 'file.modified', path, ownership: 'agent', checkpointId: '' });
    }

    return { ok: true, value: { changedFiles } };
  },
};
