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
 * The harness stores its journal in node:sqlite, added in Node 22.5. The rest
 * of jam still supports Node 20, so fail fast here with something actionable
 * rather than letting an import crash with a bare `ERR_UNKNOWN_BUILTIN_MODULE`.
 */
export function assertNodeSupported(version = process.versions.node): void {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) {
    throw new Error(
      `jam agent requires Node 22.5 or newer (found ${version}), because it stores ` +
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
  return stop === 'cancelled' ? 'cancelled by user' : `budget exhausted (${stop})`;
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
      checkpoints: new CheckpointStore(world, opts.cwd),
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
    const state: TerminalState = terminal?.type === 'session.terminal'
      ? terminal.state : 'CANCELLED';

    // No terminal event means the session was STOPPED, not finished, and stays
    // resumable. The StopReason says which — falling back to CANCELLED for all
    // of them reports a blown budget as if the user had hit Ctrl-C.
    const stoppedBecause = terminal === undefined ? describeStop(stop) : undefined;

    if (opts.json === true) {
      for (const e of events) {
        stdout.write(JSON.stringify({ ...e, logicalClock: e.logicalClock.toString() }) + '\n');
      }
    } else {
      stdout.write(renderReport(events, state, stoppedBecause));
    }
    return exitCodeFor(state);
  } finally {
    process.removeListener('SIGINT', onSigint);
    journal.close();
    artifacts.close();
  }
}

function renderReport(
  events: ReturnType<Journal['replay']>, state: TerminalState, stoppedBecause?: string
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
  out.push(stoppedBecause === undefined ? state : `${state} — ${stoppedBecause}`, '');
  // Only a session that stopped rather than finished stays resumable — a
  // COMPLETED_VERIFIED run should not be told to resume.
  if (stoppedBecause !== undefined) out.push('  Resume with: jam agent --resume <id>', '');
  return out.join('\n');
}

export async function runAgentCommand(
  task: string | undefined,
  cmdOpts: Record<string, unknown>,
  globalOpts: { provider?: string; model?: string; profile?: string }
): Promise<number> {
  const taskFile = cmdOpts['taskFile'];
  const resolved = typeof taskFile === 'string'
    ? await readFile(taskFile, 'utf-8')
    : task;

  if (resolved === undefined || resolved.trim() === '') {
    process.stderr.write('A task is required: jam agent "fix the failing tests"\n');
    return 1;
  }

  const { createHarnessProvider } = await import('../harness/provider-factory.js');
  return runAgent({
    task: resolved,
    cwd: process.cwd(),
    provider: await createHarnessProvider(globalOpts),
    extraVerify: cmdOpts['verify'] as string[] | undefined,
    json: cmdOpts['json'] === true,
    maxToolCalls: Number(cmdOpts['maxToolCalls'] ?? 200),
    timeoutMs: Number(cmdOpts['timeout'] ?? 30 * 60_000),
  });
}
