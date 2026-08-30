import { z } from 'zod';
import { relative, resolve } from 'node:path';
import type { Tool } from './types.js';

const input = z.object({
  query: z.string().describe('Literal text or regular expression to search for.'),
  glob: z.string().optional().describe('Restrict to files matching this glob.'),
  maxResults: z.number().int().positive().optional().describe('Cap on matches returned.'),
});

export interface Match { path: string; line: number; text: string }

export const searchTextTool: Tool<z.infer<typeof input>, { matches: Match[] }> = {
  name: 'search_text',
  description: 'Search the workspace for text. Prefer this over reading files speculatively.',
  input,
  risk: 'R0',
  mutates: false,
  async execute(args, ctx) {
    const max = args.maxResults ?? 100;
    const argv = ['--line-number', '--no-heading', '--color=never', '--max-count', String(max)];
    if (args.glob !== undefined) argv.push('--glob', args.glob);
    argv.push('--', args.query);

    const r = await ctx.world.subprocess.run({
      command: 'rg', args: argv, cwd: ctx.workspaceRoot,
      timeoutMs: 30_000, signal: ctx.signal, callId: ctx.callId,
    });

    // ripgrep is not bundled and is not guaranteed to be on PATH (it isn't
    // preinstalled on any current GitHub-hosted CI runner, for instance).
    // Without this check a missing binary fell through to the generic
    // non-zero-exit branch below as exitCode -1 with an empty stderr,
    // surfacing as the unhelpful "ripgrep exited -1" — same shape as a real
    // crash, and giving the model nothing to act on. Distinguishing it lets
    // the model recover the way run_command.ts's spawnFailed handling does.
    if (r.spawnFailed) {
      return { ok: false, error: {
        type: 'not_found', recoverable: true,
        message: 'Could not start "rg" (ripgrep). Is it installed and on PATH? ' +
          'Falling back to another way of locating text may be necessary.',
      } };
    }

    // rg exits 1 for "no matches", which is not an error.
    if (r.exitCode !== 0 && r.exitCode !== 1) {
      return { ok: false, error: {
        type: 'internal', recoverable: true,
        message: r.stderr.trim() || `ripgrep exited ${r.exitCode}`,
      } };
    }

    const matches: Match[] = [];
    for (const line of r.stdout.split('\n')) {
      if (line === '') continue;
      const m = /^(.*?):(\d+):(.*)$/.exec(line);
      if (m) {
        // rg is run with cwd: ctx.workspaceRoot, so m[1] is typically already
        // relative to that root (not to process.cwd()). Resolve it against
        // workspaceRoot first — node's `relative()` resolves a relative `to`
        // against process.cwd(), which silently mis-locates every match
        // whenever the harness's cwd differs from the workspace root.
        const relPath = relative(ctx.workspaceRoot, resolve(ctx.workspaceRoot, m[1]!)) || m[1]!;
        matches.push({
          // node's path helpers use the OS separator, so on Windows relPath
          // comes back with backslashes. Normalise to posix-style forward
          // slashes so a Match.path is identical no matter which platform
          // produced it — journal events, snapshots, and anything comparing
          // paths as strings should not have to special-case Windows.
          path: relPath.replace(/\\/g, '/'),
          line: Number(m[2]),
          text: m[3]!,
        });
      }
      if (matches.length >= max) break;
    }
    return { ok: true, value: { matches } };
  },
};
