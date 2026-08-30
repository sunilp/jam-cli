import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Verifier, loadRequirements } from './verify.js';
import { LocalExecutionWorld } from './world/local.js';
import type { ExecutionWorld } from './world/types.js';
import { ArtifactStore } from './artifacts.js';

const world = new LocalExecutionWorld();
let root: string;
let artifacts: ArtifactStore;
const extraDirs: string[] = [];

async function tempConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jam-cfg-'));
  extraDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jam-verify-'));
  artifacts = new ArtifactStore(':memory:');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await Promise.all(extraDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('loadRequirements', () => {
  it('treats a missing config as no requirements', async () => {
    const dir = await tempConfigDir();
    await expect(loadRequirements(world, dir)).resolves.toMatchObject({ requirements: [] });
  });

  it('is LOUD about a malformed config rather than silently declaring nothing', async () => {
    const dir = await tempConfigDir();
    await mkdir(join(dir, '.jam'));
    await writeFile(join(dir, '.jam', 'config.yaml'), 'verification: [oops\n  bad: :\n');
    await expect(loadRequirements(world, dir)).rejects.toThrow(/not valid YAML/);
  });

  it('rejects a verification.required that is not a list', async () => {
    const dir = await tempConfigDir();
    await mkdir(join(dir, '.jam'));
    await writeFile(join(dir, '.jam', 'config.yaml'), 'verification:\n  required: "npm test"\n');
    await expect(loadRequirements(world, dir)).rejects.toThrow(/must be a list/);
  });

  it('rejects a bare-string requirement instead of silently ignoring it', async () => {
    // `required: ["npm test"]` is the most natural YAML a user would write.
    // It parses to an array of bare strings, which Array.isArray accepts —
    // so without per-entry validation this reaches the Verifier, produces
    // zero results, and reports COMPLETED_UNVERIFIED with no error at all.
    const dir = await tempConfigDir();
    await mkdir(join(dir, '.jam'));
    await writeFile(join(dir, '.jam', 'config.yaml'), 'verification:\n  required:\n    - npm test\n');
    await expect(loadRequirements(world, dir)).rejects.toThrow(
      /verification\.required\[0\] must be an object with "command" or "gitDiffCheck", got "npm test"/
    );
  });

  it('rejects a requirement object with neither command nor gitDiffCheck', async () => {
    const dir = await tempConfigDir();
    await mkdir(join(dir, '.jam'));
    await writeFile(
      join(dir, '.jam', 'config.yaml'),
      'verification:\n  required:\n    - mustExit: 0\n'
    );
    await expect(loadRequirements(world, dir)).rejects.toThrow(
      /verification\.required\[0\] must be an object with "command" or "gitDiffCheck"/
    );
  });

  it('accepts a valid mixed list of command and gitDiffCheck requirements', async () => {
    const dir = await tempConfigDir();
    await mkdir(join(dir, '.jam'));
    await writeFile(
      join(dir, '.jam', 'config.yaml'),
      'verification:\n  required:\n    - command: npm test\n    - gitDiffCheck: true\n'
    );
    await expect(loadRequirements(world, dir)).resolves.toMatchObject({
      requirements: [{ command: 'npm test' }, { gitDiffCheck: true }],
    });
  });
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

  it('never reports satisfied when verification was cut short mid-run', async () => {
    // The disaster window is an abort BETWEEN requirements, after the first has
    // PASSED — that leaves a one-entry array where every entry passed, which
    // reads as satisfied without a completeness check. Pre-aborting is a
    // different, weaker case: results stays empty and the pre-existing
    // length > 0 check already blocks it, so a pre-abort test proves nothing.
    const ac = new AbortController();
    let runs = 0;
    const abortAfterFirst: ExecutionWorld = {
      ...world,
      subprocess: {
        run: async (req) => {
          const r = await world.subprocess.run(req);
          runs += 1;
          if (runs === 1) ac.abort();
          return r;
        },
      },
    };

    const v = new Verifier(abortAfterFirst, root, artifacts, [
      { command: 'node -e "process.exit(0)"', mustExit: 0 },
      { command: 'node -e "process.exit(0)"', mustExit: 0 },
    ], 3);
    const verdict = await v.evaluate(0, ac.signal);

    expect(verdict.results).toHaveLength(1);        // the first ran
    expect(verdict.results[0]!.passed).toBe(true);  // and it passed
    expect(verdict.satisfied).toBe(false);          // and it is STILL not satisfied
    expect(verdict.runnable).toBe(false);
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

  it('distinguishes a timed-out check from one that could not start', async () => {
    const slow = new Verifier(world, root, artifacts, [
      { command: 'node -e "setTimeout(()=>{},60000)"', mustExit: 0, timeoutMs: 500 },
    ], 3);
    const timedOut = await slow.evaluate(0);
    expect(timedOut.runnable).toBe(true);      // it ran; it just failed
    expect(timedOut.satisfied).toBe(false);
    expect(timedOut.results[0]!.passed).toBe(false);

    const missing = new Verifier(world, root, artifacts, [
      { command: 'definitely-not-a-real-binary-xyz', mustExit: 0 },
    ], 3);
    expect((await missing.evaluate(0)).runnable).toBe(false);
  }, 20_000);

  it('honours a per-requirement timeout instead of the 10 minute default', async () => {
    const started = Date.now();
    const v = new Verifier(world, root, artifacts, [
      { command: 'node -e "setTimeout(()=>{},60000)"', mustExit: 0, timeoutMs: 400 },
    ], 3);
    await v.evaluate(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it('requires EVERY declared requirement to pass, not just one', async () => {
    const v = new Verifier(world, root, artifacts, [
      { command: 'node -e "process.exit(0)"', mustExit: 0 },
      { command: 'node -e "process.exit(1)"', mustExit: 0 },
    ], 3);
    const verdict = await v.evaluate(0);
    expect(verdict.runnable).toBe(true);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.results.map((r) => r.passed)).toEqual([true, false]);
  });

  it('marks a requirement that cannot be executed as not runnable', async () => {
    const v = new Verifier(world, root, artifacts, [
      { command: 'definitely-not-a-real-binary-xyz', mustExit: 0 },
    ], 3);
    const verdict = await v.evaluate(0);
    expect(verdict.runnable).toBe(false);
    expect(verdict.results[0]!.passed).toBe(false);
  });

  it('treats exit 9009 (cmd.exe "not recognized") as not runnable, same as 127', async () => {
    // 127 is what /bin/sh reports for a missing command; this repo's own
    // Verifier always spawns via shellInvocation (/bin/sh on POSIX, cmd.exe
    // on win32), so the platform this suite actually runs on here (POSIX)
    // can never itself produce 9009. Mocked directly so this branch is
    // covered without a Windows machine to spawn cmd.exe on.
    const cmdExeNotFound: ExecutionWorld = {
      ...world,
      subprocess: {
        run: async (req) => ({
          ...(await world.subprocess.run(req)),
          exitCode: 9009, spawnFailed: false,
        }),
      },
    };
    const v = new Verifier(cmdExeNotFound, root, artifacts, [
      { command: 'node -e "process.exit(0)"', mustExit: 0 },
    ], 3);
    const verdict = await v.evaluate(0);
    expect(verdict.runnable).toBe(false);
    expect(verdict.results[0]!.passed).toBe(false);
  });
});
