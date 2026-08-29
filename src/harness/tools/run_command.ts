import { z } from 'zod';
import { preview } from '../artifacts.js';
import type { Tool } from './types.js';
import type { RiskLevel } from '../events.js';

const input = z.object({
  command: z.string().describe('Executable to run. Not a shell string.'),
  args: z.array(z.string()).optional().describe('Arguments passed to the executable.'),
  timeoutMs: z.number().int().positive().optional().describe('Timeout in milliseconds.'),
});

const R0 = new Set(['ls', 'cat', 'rg', 'grep', 'find', 'head', 'tail', 'wc', 'which', 'pwd', 'echo']);
const R1 = new Set(['npm', 'pnpm', 'yarn', 'node', 'npx', 'tsc', 'cargo', 'go', 'make',
                    'pytest', 'python', 'python3', 'uv', 'pip', 'ruff', 'eslint', 'prettier',
                    'vitest', 'jest', 'mvn', 'gradle']);
const R2 = new Set(['curl', 'wget', 'docker', 'podman', 'ssh', 'scp', 'nc']);
const R3 = new Set(['rm', 'mv', 'dd', 'truncate', 'shred']);
const R4 = new Set(['terraform', 'kubectl', 'aws', 'gcloud', 'az', 'helm',
                    'sudo', 'su', 'chown', 'chmod', 'mkfs', 'shutdown', 'reboot']);

// Destructive git subcommands. `checkout` earns its place: `git checkout -- .`
// silently discards every uncommitted change in the tree.
const GIT_R3 = new Set([
  'reset', 'clean', 'push', 'checkout', 'restore', 'rm', 'filter-branch', 'gc', 'prune',
]);
// `git stash drop` / `clear` destroy stashed work; `stash list` does not.
const GIT_STASH_R3 = new Set(['drop', 'clear', 'pop']);

/**
 * Interpreters given inline code. `node -e "require('fs').readFileSync('/etc/passwd')"`
 * reads anything on the machine, and the path never appears as its own argument
 * so no path check can see it. Auto-allowing that is not defensible; a human
 * looks at it until real sandboxing lands.
 */
const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'php', 'deno', 'bun']);
const EVAL_FLAGS = new Set(['-e', '--eval', '-c', '--command', '-p', '--print']);

/**
 * A conservative classifier. Real argument and pipeline parsing is sub-project 2
 * (spec section 26); until then an unknown executable is R2, never R0, so it
 * reaches a human rather than running silently.
 */
export function classifyRisk(command: string, args: string[] = []): RiskLevel {
  const exe = command.split('/').pop() ?? command;

  if (R4.has(exe)) return 'R4';
  if (INTERPRETERS.has(exe) && args.some((a) => EVAL_FLAGS.has(a))) return 'R2';
  if (exe === 'git') {
    const sub = args[0] ?? '';
    if (sub === 'stash') return GIT_STASH_R3.has(args[1] ?? '') ? 'R3' : 'R0';
    if (GIT_R3.has(sub)) return 'R3';
    return 'R0';
  }
  if (R3.has(exe)) return 'R3';
  if (R2.has(exe)) return 'R2';
  if (R1.has(exe)) return 'R1';
  if (R0.has(exe)) return 'R0';
  return 'R2';
}

export const runCommandTool: Tool<
  z.infer<typeof input>,
  { exitCode: number; output: string; timedOut: boolean }
> = {
  name: 'run_command',
  description: 'Run a command in the workspace. Provide the executable and arguments separately.',
  input,
  risk: (i) => classifyRisk(i.command, i.args ?? []),
  mutates: true,
  async execute(args, ctx) {
    const r = await ctx.world.subprocess.run({
      command: args.command,
      args: args.args ?? [],
      cwd: ctx.workspaceRoot,
      timeoutMs: args.timeoutMs ?? 120_000,
      signal: ctx.signal,
      callId: ctx.callId,
    });

    const combined = r.stderr === '' ? r.stdout : `${r.stdout}\n--- stderr ---\n${r.stderr}`;
    const artifact = ctx.artifacts.put(combined);

    // A process that could not START is not a command result. Without this it
    // returns ok:true with exitCode -1, indistinguishable from a command that
    // legitimately exited -1 — which is exactly why ProcResult carries
    // spawnFailed separately from exitCode.
    if (r.spawnFailed) {
      return { ok: false, error: {
        type: 'not_found', recoverable: false,
        message: `Could not start "${args.command}". Is it installed and on PATH?`,
      } };
    }

    if (r.timedOut) {
      return { ok: false, error: {
        type: 'shell.timeout', recoverable: true,
        message: `Command timed out after ${args.timeoutMs ?? 120_000}ms`,
        details: { artifactDigest: artifact.digest },
      } };
    }

    // Cancellation is not a command result either.
    if (r.aborted) {
      return { ok: false, error: {
        type: 'internal', recoverable: false, message: 'Command cancelled.',
      } };
    }

    // A non-zero exit is information, not a harness failure. The model needs it.
    return {
      ok: true,
      value: { exitCode: r.exitCode, output: preview(combined), timedOut: false },
      artifact,
    };
  },
};
