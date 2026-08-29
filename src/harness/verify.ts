import { createHash } from 'node:crypto';
import { load } from 'js-yaml';
import { join } from 'node:path';
import type { ExecutionWorld } from './world/types.js';
import type { ArtifactStore } from './artifacts.js';
import type { Requirement, VerificationResult } from './events.js';

export interface Verdict {
  runnable: boolean;
  satisfied: boolean;
  exhausted: boolean;
  results: VerificationResult[];
}

/**
 * Deterministic and separate from the model. The model may run tests itself,
 * but only what this produces counts as evidence. See spec 9.3.
 */
export class Verifier {
  constructor(
    private readonly world: ExecutionWorld,
    private readonly root: string,
    private readonly artifacts: ArtifactStore,
    /** Snapshotted at session start. Never re-read from disk. */
    private readonly requirements: Requirement[],
    private readonly maxRetries: number
  ) {}

  async evaluate(round: number): Promise<Verdict> {
    if (this.requirements.length === 0) {
      return { runnable: false, satisfied: false, exhausted: true, results: [] };
    }

    const results: VerificationResult[] = [];
    let executable = true;

    for (const req of this.requirements) {
      if (req.gitDiffCheck === true) {
        const { result } = await this.run('git diff --check', 'git', ['diff', '--check'], 0);
        results.push(result);
        continue;
      }
      if (req.command === undefined) continue;

      const [exe, args] = shellInvocation(req.command);
      const { result, spawnFailed } = await this.run(req.command, exe, args, req.mustExit ?? 0);
      // spawnFailed, not exitCode -1: a killed process also reports -1, and
      // treating a timed-out check as "not executable" would report
      // COMPLETED_UNVERIFIED instead of COMPLETED_PARTIAL.
      if (spawnFailed || result.exitCode === 127) executable = false;
      results.push(result);
    }

    const satisfied = executable && results.length > 0 && results.every((r) => r.passed);
    return {
      runnable: executable && results.length > 0,
      satisfied,
      exhausted: round >= this.maxRetries,
      results,
    };
  }

  private async run(
    label: string, exe: string, args: string[], mustExit: number
  ): Promise<{ result: VerificationResult; spawnFailed: boolean }> {
    const r = await this.world.subprocess.run({
      command: exe, args, cwd: this.root, timeoutMs: 600_000,
    });
    const combined = r.stderr === '' ? r.stdout : `${r.stdout}\n--- stderr ---\n${r.stderr}`;
    const artifact = this.artifacts.put(combined);
    return {
      spawnFailed: r.spawnFailed,
      result: {
        requirement: label,
        exitCode: r.exitCode,
        passed: r.exitCode === mustExit && !r.timedOut,
        durationMs: r.durationMs,
        outputDigest: createHash('sha256').update(combined).digest('hex'),
        artifactDigest: artifact.digest,
      },
    };
  }
}

/**
 * Verification commands run through a shell, unlike run_command.
 *
 * They come from the user's own .jam/config.yaml (provenance 'declared'), not
 * from the model, and users write `npm test -- --run`, quoted arguments and
 * pipelines. Splitting on whitespace silently corrupts those: `node -e
 * "process.exit(1)"` becomes ['node','-e','"process.exit(1)"'], which makes
 * node evaluate a string literal and exit 0 — a failing check that reports
 * success, which is the exact failure this whole subsystem exists to prevent.
 *
 * The model cannot reach this path: it cannot modify .jam/ (DefaultPolicy) and
 * the requirements are snapshotted at session start.
 */
export function shellInvocation(command: string): [string, string[]] {
  return process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', command]]
    : ['/bin/sh', ['-c', command]];
}

/** Read once, at session start. The snapshot then governs the whole session. */
export async function loadRequirements(
  world: ExecutionWorld, root: string
): Promise<{ requirements: Requirement[]; maxRetries: number }> {
  try {
    const raw = await world.fs.readFile(join(root, '.jam', 'config.yaml'));
    const parsed = load(raw) as { verification?: { required?: Requirement[]; maxRetries?: number } };
    return {
      requirements: parsed?.verification?.required ?? [],
      maxRetries: parsed?.verification?.maxRetries ?? 3,
    };
  } catch {
    return { requirements: [], maxRetries: 3 };
  }
}
