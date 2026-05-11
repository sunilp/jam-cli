import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Phase 1 regression guard.
 *
 * trace must remain functional with the AI-suite, src/agent/, src/tools/, src/intel/,
 * and the archive-bound utils removed. This test exercises runTrace on a tiny TS+SQL
 * fixture using --no-ai and asserts the cross-language graph is built. It does NOT
 * import anything from src/agent, src/tools, src/intel, or the archive-bound utils.
 */

// Mock getWorkspaceRoot so we can point it at our temp fixture directory
// without calling process.chdir() (unsupported in vitest worker threads).
vi.mock('../../utils/workspace.js', () => ({
  getWorkspaceRoot: vi.fn(),
  findGitRoot: vi.fn(),
  isGitRepo: vi.fn().mockResolvedValue(false),
}));

describe('trace smoke (Phase 1 regression guard)', () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'jam-trace-smoke-'));
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(
      join(workspace, 'src', 'user.ts'),
      `export function getUserById(id: number) {\n  return db.query('SELECT * FROM users WHERE id = ?', [id]);\n}\n`,
    );
    await writeFile(
      join(workspace, 'src', 'caller.ts'),
      `import { getUserById } from './user.js';\nexport function loadProfile(id: number) {\n  return getUserById(id);\n}\n`,
    );

    // Point workspace.getWorkspaceRoot at our temp directory
    const workspaceMod = await import('../../utils/workspace.js');
    vi.mocked(workspaceMod.getWorkspaceRoot).mockResolvedValue(workspace);
  });

  afterAll(async () => {
    await rm(workspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('builds an index and finds callers of getUserById without AI', async () => {
    const { runTrace } = await import('../trace.js');
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout.write as any) = (s: string) => { chunks.push(String(s)); return true; };
    try {
      await runTrace('getUserById', { noAi: true, reindex: true });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout.write as any) = origWrite;
    }
    const output = chunks.join('');
    expect(output).toMatch(/getUserById/);
    expect(output).toMatch(/loadProfile|caller\.ts/);
  });
});
