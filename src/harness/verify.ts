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

  async evaluate(round: number, signal?: AbortSignal): Promise<Verdict> {
    if (this.requirements.length === 0) {
      return { runnable: false, satisfied: false, exhausted: true, results: [] };
    }

    const results: VerificationResult[] = [];
    let executable = true;

    for (const req of this.requirements) {
      // Threaded so Ctrl-C kills a long check rather than outrunning it.
      if (signal?.aborted === true) break;

      if (req.gitDiffCheck === true) {
        const { result } = await this.run(
          'git diff --check', 'git', ['diff', '--check'], 0, req.timeoutMs, signal
        );
        results.push(result);
        continue;
      }
      if (req.command === undefined) continue;

      const [exe, args] = shellInvocation(req.command);
      const { result, spawnFailed } = await this.run(
        req.command, exe, args, req.mustExit ?? 0, req.timeoutMs, signal
      );
      // spawnFailed, not exitCode -1: a killed process also reports -1, and
      // treating a timed-out check as "not executable" would report
      // COMPLETED_UNVERIFIED instead of COMPLETED_PARTIAL.
      // 127 is /bin/sh's "command not found"; 9009 is cmd.exe's equivalent
      // ("... is not recognized as an internal or external command") on the
      // Windows branch of shellInvocation above. Without 9009 a missing
      // command on Windows would read as a legitimate non-zero exit rather
      // than "the requirement itself cannot run."
      if (spawnFailed || result.exitCode === 127 || result.exitCode === 9009) executable = false;
      results.push(result);
    }

    // Every declared requirement must have RUN. Cancelling between two
    // requirements otherwise leaves a partial results array whose entries all
    // passed, and satisfied would be true — reaching COMPLETED_VERIFIED by
    // aborting at the right moment, with requirements never checked.
    const complete = results.length === this.requirements.length;
    const satisfied = executable && complete && results.length > 0 && results.every((r) => r.passed);
    return {
      runnable: executable && complete && results.length > 0,
      satisfied,
      exhausted: round >= this.maxRetries,
      results,
    };
  }

  private async run(
    label: string, exe: string, args: string[], mustExit: number,
    timeoutMs = 600_000, signal?: AbortSignal
  ): Promise<{ result: VerificationResult; spawnFailed: boolean }> {
    // Threaded so Ctrl-C kills a long check. Without it the wall-clock deadline
    // is only a between-rounds gate and one slow requirement outruns it.
    const r = await this.world.subprocess.run({
      command: exe, args, cwd: this.root, timeoutMs, signal,
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
  let raw: string;
  try {
    raw = await world.fs.readFile(join(root, '.jam', 'config.yaml'));
  } catch (err) {
    // No config is a legitimate state: the session simply cannot reach
    // COMPLETED_VERIFIED. Anything else (EACCES, EISDIR) is not, and must not
    // masquerade as it.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { requirements: [], maxRetries: 3 };
    }
    throw new Error(`Cannot read .jam/config.yaml: ${(err as NodeJS.ErrnoException).code}`);
  }

  // A malformed config must be LOUD. Swallowing it silently yields zero
  // requirements, which looks exactly like "none declared" — so a typo would
  // quietly guarantee the session can never verify, and nobody would know why.
  let parsed: { verification?: { required?: Requirement[]; maxRetries?: number } };
  try {
    parsed = load(raw) as typeof parsed;
  } catch (err) {
    throw new Error(
      `.jam/config.yaml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const required = parsed?.verification?.required;
  if (required !== undefined && !Array.isArray(required)) {
    throw new Error('.jam/config.yaml: verification.required must be a list.');
  }

  // `required: ["npm test"]` is the most natural YAML a user would write, and
  // it parses to an array of bare strings — which Array.isArray happily
  // accepts. Left unchecked, each entry then has neither `command` nor
  // `gitDiffCheck`, so the Verifier's own loop silently `continue`s past it:
  // zero results, COMPLETED_UNVERIFIED, no error. That is exactly the failure
  // this function's own "must be LOUD" comment exists to prevent.
  if (required !== undefined) {
    // Typed as `unknown` here, not the declared `Requirement`: `parsed` above
    // is produced by casting js-yaml's untyped output, which is a lie about
    // runtime shape — a bare string in the YAML really does reach this
    // callback as a string, whatever the static type claims.
    required.forEach((entry: unknown, i) => {
      const isObject = typeof entry === 'object' && entry !== null && !Array.isArray(entry);
      const hasCommand = isObject && typeof (entry as Requirement).command === 'string' &&
        (entry as Requirement).command !== '';
      const hasGitDiffCheck = isObject && (entry as Requirement).gitDiffCheck === true;
      if (!isObject || (!hasCommand && !hasGitDiffCheck)) {
        throw new Error(
          `.jam/config.yaml: verification.required[${i}] must be an object with ` +
          `"command" or "gitDiffCheck", got ${JSON.stringify(entry)}`
        );
      }
    });
  }

  return { requirements: required ?? [], maxRetries: parsed?.verification?.maxRetries ?? 3 };
}
