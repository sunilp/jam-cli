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

const GIT_R3 = new Set(['reset', 'clean', 'push']);

/**
 * A conservative classifier. Real argument and pipeline parsing is sub-project 2
 * (spec section 26); until then an unknown executable is R2, never R0, so it
 * reaches a human rather than running silently.
 */
export function classifyRisk(command: string, args: string[] = []): RiskLevel {
  const exe = command.split('/').pop() ?? command;

  if (R4.has(exe)) return 'R4';
  if (exe === 'git') {
    const sub = args[0] ?? '';
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

    if (r.timedOut) {
      return { ok: false, error: {
        type: 'shell.timeout', recoverable: true,
        message: `Command timed out after ${args.timeoutMs ?? 120_000}ms`,
        details: { artifactDigest: artifact.digest },
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
