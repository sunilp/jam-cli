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
        matches.push({
          path: relative(ctx.workspaceRoot, resolve(ctx.workspaceRoot, m[1]!)) || m[1]!,
          line: Number(m[2]),
          text: m[3]!,
        });
      }
      if (matches.length >= max) break;
    }
    return { ok: true, value: { matches } };
  },
};
