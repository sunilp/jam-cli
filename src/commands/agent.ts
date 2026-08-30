import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { stdout } from 'node:process';
import { Journal } from '../harness/journal.js';
import { ArtifactStore } from '../harness/artifacts.js';
import { ToolRegistry } from '../harness/tools/registry.js';
import { DefaultPolicy } from '../harness/kernel/policy.js';
import { TerminalApprovalHost } from '../harness/kernel/approval.js';
import { LocalExecutionWorld } from '../harness/world/local.js';
import { RingTelemetry } from '../harness/telemetry.js';
import { NaiveContext } from '../harness/context.js';
import { Verifier, loadRequirements } from '../harness/verify.js';
import { runTurn } from '../harness/loop.js';
import { CheckpointStore } from '../harness/checkpoint.js';
import { readFileTool } from '../harness/tools/read_file.js';
import { listDirTool } from '../harness/tools/list_dir.js';
import { searchTextTool } from '../harness/tools/search_text.js';
import { gitDiffTool } from '../harness/tools/git_diff.js';
import { applyPatchTool } from '../harness/tools/apply_patch.js';
import { runCommandTool } from '../harness/tools/run_command.js';
import type { ModelProvider } from '../harness/model.js';
import type { StopReason } from '../harness/session.js';
import type { TerminalState, Requirement } from '../harness/events.js';

/**
 * The harness stores its journal in node:sqlite. The module itself landed in
 * Node 22.5, but stayed behind the --experimental-sqlite flag through 22.12 —
 * `require('node:sqlite')` throws ERR_UNKNOWN_BUILTIN_MODULE on any of those
 * versions when the flag isn't set. It only became usable unflagged in Node
 * 22.13. The rest of jam still supports Node 20, so fail fast here with
 * something actionable rather than letting an import crash with a bare
 * `ERR_UNKNOWN_BUILTIN_MODULE`.
 */
export function assertNodeSupported(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(
      `jam agent requires Node 22.13 or newer (found ${version}), because it stores ` +
      `session history using the built-in node:sqlite module. Other jam commands ` +
      `still work on Node 20.`
    );
  }
}

export function exitCodeFor(state: TerminalState): number {
  switch (state) {
    case 'COMPLETED_VERIFIED': return 0;
    case 'COMPLETED_PARTIAL': return 1;
    case 'FAILED': return 1;
    case 'COMPLETED_UNVERIFIED': return 3;
    case 'CANCELLED': return 4;
  }
}

/** Why a session stopped without finishing. Exported for testing. */
export function describeStop(stop: StopReason): string {
  if (stop === 'cancelled') return 'cancelled by user';
  // 'deadline' is the wall-clock timeout, distinct from the tool-call cap
  // ('max_turn_requests') — both used to render as identical text, which
  // told a --timeout 15000 user and a --max-tool-calls 0 user the exact
  // same "budget exhausted (max_turn_requests)".
  if (stop === 'deadline') return 'time limit reached';
  return `budget exhausted (${stop})`;
}

/**
 * A NaN budget silently disables the cap: every >= comparison against NaN is
 * false. `Number('oops')` is NaN, so `--max-tool-calls oops` or `--timeout
 * oops` would otherwise pass straight through to Budget.check() and the run
 * would go unbounded — measured at 248 seconds against a run that should
 * have been capped.
 */
export function positiveIntOr(value: unknown, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${flag} must be a non-negative number, got "${String(value)}"`);
  }
  return Math.floor(n);
}

export interface AgentOptions {
  task: string;
  cwd: string;
  provider: ModelProvider;
  extraVerify?: string[];
  json?: boolean;
  maxToolCalls?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Overrides the journal/artifact database path. Production always uses
   * ~/.jam/harness.db; tests pass a scratch path so they never touch a
   * developer's real home directory.
   */
  dbPath?: string;
}

function dbPath(override?: string): string {
  const path = override ?? join(homedir(), '.jam', 'harness.db');
  mkdirSync(dirname(path), { recursive: true });
  return path;
}

export function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(readFileTool);
  r.register(listDirTool);
  r.register(searchTextTool);
  r.register(gitDiffTool);
  r.register(applyPatchTool);
  r.register(runCommandTool);
  return r;
}

export async function runAgent(opts: AgentOptions): Promise<number> {
  assertNodeSupported();
  const world = new LocalExecutionWorld();

  // loadRequirements can throw on a malformed .jam/config.yaml (a non-list
  // verification.required, invalid YAML, or a non-ENOENT read error). It runs
  // before any session exists, so an unhandled throw here would surface as an
  // uncaught rejection and a raw stack trace instead of a clean exit.
  let loaded: { requirements: Requirement[]; maxRetries: number };
  try {
    loaded = await loadRequirements(world, opts.cwd);
  } catch (err) {
    process.stderr.write(
      `jam agent: cannot start — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }

  const requirements: Requirement[] = [
    ...loaded.requirements,
    ...(opts.extraVerify ?? []).map((command) => ({ command, mustExit: 0 })),
  ];

  const path = dbPath(opts.dbPath);
  const journal = new Journal(path);
  const artifacts = new ArtifactStore(path);
  const registry = buildRegistry();
  const sessionId = journal.createSession({
    task: opts.task, cwd: opts.cwd, requirements,
  });

  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = (): void => {
    interrupts += 1;
    controller.abort();
    if (interrupts >= 2) process.exit(exitCodeFor('CANCELLED'));
  };
  process.on('SIGINT', onSigint);

  const checkpoints = new CheckpointStore(world, opts.cwd);
  // Defaults to a non-VERIFIED value so an exception thrown before this is
  // reassigned still leaves the finally block's prune guard closed — nothing
  // is pruned unless the session is positively known to have reached
  // COMPLETED_VERIFIED.
  let state: TerminalState = 'CANCELLED';

  try {
    const stop = await runTurn({
      journal, artifacts, registry, world,
      policy: new DefaultPolicy(),
      approvals: new TerminalApprovalHost(),
      telemetry: new RingTelemetry(),
      workspaceRoot: opts.cwd,
      provider: opts.provider,
      context: new NaiveContext(journal, registry),
      verifier: new Verifier(world, opts.cwd, artifacts, requirements, loaded.maxRetries),
      checkpoints,
      budget: {
        maxToolCalls: opts.maxToolCalls ?? 200,
        maxTokens: opts.maxTokens ?? 2_000_000,
        deadlineMs: Date.now() + (opts.timeoutMs ?? 30 * 60_000),
      },
    }, sessionId, opts.task, controller.signal);

    const events = journal.replay(sessionId);
    const terminal = events.map((e) => e.event).find((e) => e.type === 'session.terminal');
    // A cancelled OR budget-stopped session writes no terminal event at all
    // (see harness/loop.ts) — both stay resumable by design. This is the one
    // place that gap is resolved into a reportable state; exitCodeFor still
    // treats every such stop as CANCELLED, see describeStop for what actually
    // distinguishes them for the human-readable report.
    state = terminal?.type === 'session.terminal' ? terminal.state : 'CANCELLED';

    // No terminal event means the session was STOPPED, not finished, and stays
    // resumable. The StopReason says which — falling back to CANCELLED for all
    // of them reports a blown budget as if the user had hit Ctrl-C.
    const stoppedBecause = terminal === undefined ? describeStop(stop) : undefined;

    // Only a verified run has nothing left that could need rolling back — see
    // the prune() call in `finally` below. Everywhere else the checkpoints
    // must stay, so the report says how many were kept rather than silently
    // leaving refs behind with no explanation.
    const keptCheckpoints = state === 'COMPLETED_VERIFIED' ? 0 : (await checkpoints.list()).length;

    if (opts.json === true) {
      for (const e of events) {
        stdout.write(JSON.stringify({ ...e, logicalClock: e.logicalClock.toString() }) + '\n');
      }
    } else {
      stdout.write(renderReport(events, state, sessionId, stoppedBecause, keptCheckpoints));
    }
    return exitCodeFor(state);
  } finally {
    // Checkpoints are permanent git refs (refs/jam/checkpoints/<id>) immune to
    // `git gc`. Only a COMPLETED_VERIFIED session has nothing left that could
    // need rolling back, so pruning is scoped to exactly that case — anything
    // else (partial, unverified, failed, cancelled, budget-stopped) leaves
    // them in place on purpose.
    if (state === 'COMPLETED_VERIFIED') {
      try {
        await checkpoints.prune();
      } catch {
        // Best-effort housekeeping; a failure here must not mask the run's
        // actual outcome, which has already been reported above.
      }
    }
    process.removeListener('SIGINT', onSigint);
    journal.close();
    artifacts.close();
  }
}

function renderReport(
  events: ReturnType<Journal['replay']>, state: TerminalState,
  sessionId: string, stoppedBecause?: string, keptCheckpoints = 0
): string {
  const changed = new Set<string>();
  const lines: string[] = [];

  for (const { event } of events) {
    if (event.type === 'file.modified') changed.add(event.path);
    if (event.type === 'verification.completed') {
      lines.length = 0;
      for (const r of event.results) {
        lines.push(`  ${r.passed ? '✓' : '✗'} ${r.requirement} — exit ${r.exitCode} ` +
                   `(${(r.durationMs / 1000).toFixed(1)}s)`);
      }
    }
  }

  const out = [''];
  if (changed.size > 0) {
    out.push('Changed:', ...[...changed].map((p) => `  ${p}`), '');
  }
  // Every line below comes from a VerificationResult, never from model prose.
  if (lines.length > 0) out.push('Verification:', ...lines, '');
  // A stopped session has no terminal state, so print the cause instead of the
  // CANCELLED placeholder — "CANCELLED — budget exhausted" tells the user they
  // pressed Ctrl-C, which is the confusion this whole fix exists to remove.
  out.push(stoppedBecause ?? state, '');
  // Only a session that stopped rather than finished stays resumable — a
  // COMPLETED_VERIFIED run should not be told to resume. Name the session id,
  // not a --resume flag: that flag does not exist in index.ts yet, and the id
  // is what actually matters to someone who wants to pick this back up.
  if (stoppedBecause !== undefined) {
    out.push(`  Session ${sessionId} kept; nothing was finalised.`, '');
  }
  // Checkpoints are only pruned after a COMPLETED_VERIFIED run (see
  // runAgent's finally), so this only ever fires for an outcome that left
  // them in place on purpose — a silent permanent git ref is worse than one
  // that at least says it is there.
  if (keptCheckpoints > 0) {
    out.push(`  ${keptCheckpoints} checkpoint${keptCheckpoints === 1 ? '' : 's'} kept ` +
              `under refs/jam/checkpoints/ (run was not verified, so nothing was pruned).`, '');
  }
  return out.join('\n');
}

export async function runAgentCommand(
  task: string | undefined,
  cmdOpts: Record<string, unknown>,
  globalOpts: { provider?: string; model?: string; profile?: string }
): Promise<number> {
  // ONE boundary around everything that can throw before the session exists:
  // the task-file read, the Node version guard, config loading and provider
  // construction. Without it a mistyped path, an unusable provider or an old
  // runtime crashes with a raw stack trace — and the version guard exists
  // precisely to print an actionable message.
  try {
    const taskFile = cmdOpts['taskFile'];
    const resolved = typeof taskFile === 'string'
      ? await readFile(taskFile, 'utf-8')
      : task;

    if (resolved === undefined || resolved.trim() === '') {
      process.stderr.write('A task is required: jam agent "fix the failing tests"\n');
      return 1;
    }

    const { createHarnessProvider } = await import('../harness/provider-factory.js');
    return await runAgent({
      task: resolved,
      cwd: process.cwd(),
      provider: await createHarnessProvider(globalOpts),
      extraVerify: cmdOpts['verify'] as string[] | undefined,
      json: cmdOpts['json'] === true,
      maxToolCalls: positiveIntOr(cmdOpts['maxToolCalls'], 200, '--max-tool-calls'),
      timeoutMs: positiveIntOr(cmdOpts['timeout'], 30 * 60_000, '--timeout'),
    });
  } catch (err) {
    process.stderr.write(
      `jam agent: cannot start — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }
}
