import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Verifier } from './verify.js';
import { LocalExecutionWorld } from './world/local.js';
import { ArtifactStore } from './artifacts.js';

const world = new LocalExecutionWorld();
let root: string;
let artifacts: ArtifactStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jam-verify-'));
  artifacts = new ArtifactStore(':memory:');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('Verifier', () => {
  it('is not runnable when nothing is declared, so VERIFIED is unreachable', async () => {
    const v = new Verifier(world, root, artifacts, [], 3);
    const verdict = await v.evaluate(0);
    expect(verdict.runnable).toBe(false);
    expect(verdict.satisfied).toBe(false);
  });

  it('is satisfied when every requirement passes', async () => {
    const v = new Verifier(world, root, artifacts, [
      { command: 'node -e "process.exit(0)"', mustExit: 0 },
    ], 3);
    const verdict = await v.evaluate(0);
    expect(verdict.runnable).toBe(true);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.results[0]!.passed).toBe(true);
  });

  it('is unsatisfied and not yet exhausted on the first failure', async () => {
    const v = new Verifier(world, root, artifacts, [
      { command: 'node -e "process.exit(1)"', mustExit: 0 },
    ], 3);
    const verdict = await v.evaluate(0);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.exhausted).toBe(false);
  });

  it('is exhausted once the retry budget is spent', async () => {
    const v = new Verifier(world, root, artifacts, [
      { command: 'node -e "process.exit(1)"', mustExit: 0 },
    ], 3);
    expect((await v.evaluate(3)).exhausted).toBe(true);
  });

  it('records evidence with a digest and an artifact for every run', async () => {
    const v = new Verifier(world, root, artifacts, [
      { command: 'node -e "console.log(42)"', mustExit: 0 },
    ], 3);
    const r = (await v.evaluate(0)).results[0]!;
    expect(r.outputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(artifacts.get(r.artifactDigest)).toContain('42');
  });

  it('runs quoted commands through a shell so a failing check really fails', async () => {
    // Whitespace splitting would make node evaluate the string literal
    // "process.exit(1)" and exit 0 — a failing check reporting success.
    const v = new Verifier(world, root, artifacts, [
      { command: 'node -e "process.exit(1)"', mustExit: 0 },
    ], 3);
    const r = (await v.evaluate(0)).results[0]!;
    expect(r.exitCode).toBe(1);
    expect(r.passed).toBe(false);
  });

  it('marks a requirement that cannot be executed as not runnable', async () => {
    const v = new Verifier(world, root, artifacts, [
      { command: 'definitely-not-a-real-binary-xyz', mustExit: 0 },
    ], 3);
    const verdict = await v.evaluate(0);
    expect(verdict.runnable).toBe(false);
    expect(verdict.results[0]!.passed).toBe(false);
  });
});
