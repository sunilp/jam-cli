import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileTool } from './read_file.js';
import { listDirTool } from './list_dir.js';
import { searchTextTool } from './search_text.js';
import { gitDiffTool } from './git_diff.js';
import { LocalExecutionWorld } from '../world/local.js';
import { ArtifactStore } from '../artifacts.js';
import type { ToolContext } from './types.js';

let root: string;
let ctx: ToolContext;

// ripgrep is not preinstalled on GitHub-hosted CI runners (checked against
// the actions/runner-images manifests for the current Ubuntu, macOS and
// Windows images: none list it), and jam does not bundle it. Rather than
// installing it as a CI step — which this sandbox has no way to verify
// actually succeeds on all three OSes — probe for the real binary once and
// skip the tests that need it, loudly, so a green run here doesn't quietly
// imply search_text's real ripgrep integration was exercised. search_text's
// own handling of a genuinely missing rg is covered separately, by mocking
// spawnFailed below, and does not depend on this probe.
const rgAvailable = (() => {
  try { execFileSync('rg', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();
if (!rgAvailable) {
  console.warn(
    '\nSKIPPING ripgrep-dependent search_text tests: `rg` is not on PATH.\n'
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'jam-ro-'));
  await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\n');
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'sub', 'b.ts'), 'export const needle = 1;\n');
  ctx = {
    world: new LocalExecutionWorld(),
    workspaceRoot: root,
    signal: new AbortController().signal,
    emit: () => {},
    artifacts: new ArtifactStore(':memory:'),
    callId: 'c1',
  };
});

describe('read_file', () => {
  it('reads a whole file', async () => {
    const r = await readFileTool.execute({ path: 'a.txt' }, ctx);
    expect(r.ok && r.value.content).toBe('one\ntwo\nthree\n');
  });

  it('reads a line range', async () => {
    const r = await readFileTool.execute({ path: 'a.txt', startLine: 2, endLine: 3 }, ctx);
    expect(r.ok && r.value.content).toBe('two\nthree');
  });

  it('returns not_found rather than throwing', async () => {
    const r = await readFileTool.execute({ path: 'missing.txt' }, ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.type).toBe('not_found');
  });

  it('returns sandbox.denied for traversal', async () => {
    const r = await readFileTool.execute({ path: '../../etc/passwd' }, ctx);
    expect(!r.ok && r.error.type).toBe('sandbox.denied');
  });

  // chmod 0o000 does not remove read access on Windows (fs.chmod there only
  // toggles the read-only ATTRIBUTE, not ACL read permission), so this would
  // not exercise the sandbox.denied path at all — it would just read the
  // file. Skipped explicitly rather than left to silently pass for the
  // wrong reason.
  it.skipIf(process.platform === 'win32')(
    'returns sandbox.denied rather than throwing when the file is unreadable',
    async () => {
      await chmod(join(root, 'a.txt'), 0o000);
      try {
        const r = await readFileTool.execute({ path: 'a.txt' }, ctx);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error.type).toBe('sandbox.denied');
      } finally {
        await chmod(join(root, 'a.txt'), 0o644);
      }
    },
  );
});

describe('list_dir', () => {
  it('lists entries', async () => {
    const r = await listDirTool.execute({ path: '.' }, ctx);
    expect(r.ok && r.value.entries.map((e) => e.name).sort()).toEqual(['a.txt', 'sub']);
  });

  // Same Windows caveat as the read_file case above: chmod 0o000 does not
  // remove read access there, so the sandbox.denied path never triggers.
  it.skipIf(process.platform === 'win32')(
    'returns sandbox.denied rather than throwing when the directory is unreadable',
    async () => {
      await chmod(join(root, 'sub'), 0o000);
      try {
        const r = await listDirTool.execute({ path: 'sub' }, ctx);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error.type).toBe('sandbox.denied');
      } finally {
        await chmod(join(root, 'sub'), 0o755);
      }
    },
  );
});

describe('git_diff', () => {
  it('returns a structured error outside a git repo rather than throwing', async () => {
    const r = await gitDiffTool.execute({}, ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.type).toBe('internal');
  });

  it('stores the full diff as an artifact and only previews it to the model', async () => {
    const world = new LocalExecutionWorld();
    const git = async (args: string[]): Promise<void> => {
      const r = await world.subprocess.run({ command: 'git', args, cwd: root, timeoutMs: 15_000 });
      if (r.exitCode !== 0) throw new Error(r.stderr);
    };
    await git(['init', '-q']);
    // Deterministic content regardless of the runner's global git config: a
    // Windows box with core.autocrlf=true would otherwise rewrite LF to CRLF
    // on checkout/restore paths these fixtures exercise (e.g. checkpoint
    // restore does `git checkout <ref> -- .`), breaking exact-content asserts.
    await git(['config', 'core.autocrlf', 'false']);
    await git(['config', 'user.email', 't@example.com']);
    await git(['config', 'user.name', 'T']);
    await git(['add', '-A']);
    await git(['commit', '-qm', 'init']);

    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
    await writeFile(join(root, 'a.txt'), `${big}\n`);

    const r = await gitDiffTool.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifact).toBeDefined();
    expect(r.value.diff).toContain('lines elided');
    expect(ctx.artifacts.get(r.artifact!.digest)).toContain('line 399');
  });
});

describe('search_text', () => {
  it.skipIf(!rgAvailable)('finds matches with file and line', async () => {
    const r = await searchTextTool.execute({ query: 'needle' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.matches[0]).toMatchObject({ path: 'sub/b.ts', line: 1 });
  });

  it.skipIf(!rgAvailable)('returns an empty list rather than an error when nothing matches', async () => {
    const r = await searchTextTool.execute({ query: 'zzzznope' }, ctx);
    expect(r.ok && r.value.matches).toEqual([]);
  });

  it('normalises a backslash-separated path to posix style', async () => {
    // ripgrep on Windows reports paths with the OS separator, so a real run
    // there would emit `sub\b.ts:1:...` — reproduced here via a stubbed rg
    // process rather than an actual Windows box, since the real binary on
    // this platform never emits backslashes to normalise in the first place.
    const winCtx = {
      ...ctx,
      world: {
        ...ctx.world,
        subprocess: {
          run: () => Promise.resolve({
            exitCode: 0, stdout: 'sub\\deep\\b.ts:3:needle\n', stderr: '',
            timedOut: false, aborted: false, spawnFailed: false, durationMs: 1,
          }),
        },
      },
    };
    const r = await searchTextTool.execute({ query: 'needle' }, winCtx);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.matches[0]).toMatchObject({ path: 'sub/deep/b.ts', line: 3 });
  });

  it('reports not_found rather than a bare "ripgrep exited -1" when rg is missing', async () => {
    // ripgrep is not preinstalled on GitHub-hosted CI runners (confirmed
    // against the actions/runner-images manifests for the current Ubuntu,
    // macOS and Windows images — none list it), and search_text is a
    // production tool, not test-only scaffolding: if `rg` genuinely isn't on
    // PATH somewhere, this is what the model actually sees. Simulated via a
    // stubbed spawnFailed result rather than by hiding the real PATH, since
    // this asserts the tool's own handling of that result, not the OS's.
    const noRgCtx = {
      ...ctx,
      world: {
        ...ctx.world,
        subprocess: {
          run: () => Promise.resolve({
            exitCode: -1, stdout: '', stderr: '', timedOut: false,
            aborted: false, spawnFailed: true, durationMs: 1,
          }),
        },
      },
    };
    const r = await searchTextTool.execute({ query: 'needle' }, noRgCtx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.type).toBe('not_found');
    expect(!r.ok && r.error.message).toMatch(/rg.*ripgrep/i);
  });
});
