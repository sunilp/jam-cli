import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTurn } from './loop.js';
import type { LoopDeps } from './loop.js';
import { Journal } from './journal.js';
import { ArtifactStore } from './artifacts.js';
import { DefaultPolicy } from './kernel/policy.js';
import { AutoApproveApprovalHost } from './kernel/approval.js';
import { LocalExecutionWorld } from './world/local.js';
import { NullTelemetry } from './telemetry.js';
import { NaiveContext } from './context.js';
import { MockProvider } from './model.js';
import { Verifier } from './verify.js';
import { buildRegistry } from '../commands/agent.js';
import { CheckpointStore } from './checkpoint.js';
import type { Requirement } from './events.js';

const world = new LocalExecutionWorld();

/**
 * A fixture repo whose test suite fails until User.email comparison is made
 * case-insensitive. The scripted model performs the section 86 flow:
 * search, read, patch, re-run tests, stop.
 */
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jam-e2e-'));
  const git = async (args: string[]): Promise<void> => {
    const r = await world.subprocess.run({ command: 'git', args, cwd: root, timeoutMs: 15_000 });
    if (r.exitCode !== 0) throw new Error(r.stderr);
  };
  await git(['init', '-q']);
  await git(['config', 'user.email', 't@example.com']);
  await git(['config', 'user.name', 'T']);

  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'user.js'),
    'exports.sameEmail = (a, b) => a === b;\n');
  await writeFile(join(root, 'test.js'),
    'const { sameEmail } = require("./src/user.js");\n' +
    'if (!sameEmail("A@x.com", "a@x.com")) { console.error("FAIL"); process.exit(1); }\n' +
    'console.log("ok");\n');
  await mkdir(join(root, '.jam'));
  await git(['add', '-A']);
  await git(['commit', '-qm', 'init']);
  return root;
}

const FIX = `--- a/src/user.js
+++ b/src/user.js
@@ -1 +1 @@
-exports.sameEmail = (a, b) => a === b;
+exports.sameEmail = (a, b) => a.toLowerCase() === b.toLowerCase();
`;

describe('vertical slice', () => {
  it('locates, edits, verifies and reports COMPLETED_VERIFIED', async () => {
    const root = await fixture();
    const requirements: Requirement[] = [{ command: 'node test.js', mustExit: 0 }];

    const journal = new Journal(':memory:');
    const artifacts = new ArtifactStore(':memory:');
    const registry = buildRegistry();

    const provider = new MockProvider([
      { content: null, toolCalls: [
        { id: '1', name: 'search_text', arguments: { query: 'sameEmail' } }] },
      { content: null, toolCalls: [
        { id: '2', name: 'read_file', arguments: { path: 'src/user.js' } }] },
      { content: null, toolCalls: [
        { id: '3', name: 'run_command', arguments: { command: 'node', args: ['test.js'] } }] },
      { content: null, toolCalls: [
        { id: '4', name: 'apply_patch', arguments: { patch: FIX } }] },
      { content: null, toolCalls: [
        { id: '5', name: 'run_command', arguments: { command: 'node', args: ['test.js'] } }] },
      { content: 'Made email comparison case-insensitive.', toolCalls: [] },
    ]);

    const deps: LoopDeps = {
      journal, artifacts, registry, world,
      policy: new DefaultPolicy(),
      approvals: new AutoApproveApprovalHost(),
      telemetry: new NullTelemetry(),
      workspaceRoot: root,
      provider,
      context: new NaiveContext(journal, registry),
      verifier: new Verifier(world, root, artifacts, requirements, 2),
      checkpoints: new CheckpointStore(world, root),
      budget: { maxToolCalls: 50, maxTokens: 1_000_000, deadlineMs: Date.now() + 120_000 },
    };

    const sessionId = journal.createSession({ task: 'case-insensitive email', cwd: root, requirements });
    const stop = await runTurn(deps, sessionId, 'case-insensitive email', new AbortController().signal);

    expect(stop).toBe('end_turn');
    expect(await readFile(join(root, 'src', 'user.js'), 'utf-8')).toContain('toLowerCase');

    const events = journal.replay(sessionId).map((e) => e.event);
    expect(events.at(-1)).toMatchObject({
      type: 'session.terminal', state: 'COMPLETED_VERIFIED',
    });

    // Evidence exists and is real, not model prose.
    const verification = events.find((e) => e.type === 'verification.completed');
    expect(verification).toMatchObject({
      results: [{ requirement: 'node test.js', exitCode: 0, passed: true }],
    });

    // The edit is reversible: a checkpoint covered the mutating batch and the
    // file.modified event points at it (spec 12, and 4.6 recoverability).
    const created = events.find((e) => e.type === 'checkpoint.created');
    expect(created).toBeDefined();
    const modified = events.find((e) => e.type === 'file.modified');
    expect(modified).toMatchObject({ path: 'src/user.js', ownership: 'agent' });
    expect((modified as { checkpointId: string }).checkpointId).not.toBe('');

    journal.close();
    artifacts.close();
  });

  it('reconstructs model-visible history from the journal alone', async () => {
    const root = await fixture();
    const journal = new Journal(':memory:');
    const registry = buildRegistry();
    const sessionId = journal.createSession({ task: 'resume me', cwd: root, requirements: [] });
    journal.append(sessionId, {
      type: 'tool.completed', callId: 'c1',
      result: { ok: true, preview: 'found it' }, durationMs: 1,
    });

    // A fresh context provider with no in-memory state rebuilds the same view.
    const rebuilt = new NaiveContext(journal, registry).build(sessionId);
    expect(rebuilt.messages[1]!.content).toBe('resume me');
    expect(rebuilt.messages.at(-1)!.content).toContain('found it');
    journal.close();
  });
});
