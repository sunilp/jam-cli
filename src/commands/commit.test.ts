import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('../utils/workspace.js', () => ({
  getWorkspaceRoot: vi.fn(),
}));

vi.mock('../config/loader.js', () => ({
  loadConfig: vi.fn(),
  getActiveProfile: vi.fn(),
}));

vi.mock('../providers/factory.js', () => ({
  createProvider: vi.fn(),
}));

vi.mock('../utils/stream.js', () => ({
  withRetry: vi.fn((fn: () => unknown) => fn()),
  collectStream: vi.fn(),
}));

vi.mock('../ui/renderer.js', () => ({
  printError: vi.fn(),
  printSuccess: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { getWorkspaceRoot } from '../utils/workspace.js';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { collectStream } from '../utils/stream.js';
import { printError, printSuccess } from '../ui/renderer.js';
import { cleanCommitMessage, runCommit } from './commit.js';

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

// ── cleanCommitMessage ────────────────────────────────────────────────────────

describe('cleanCommitMessage', () => {
  it('returns the message unchanged when no fences are present', () => {
    expect(cleanCommitMessage('feat: add login page')).toBe('feat: add login page');
  });

  it('strips triple-backtick wrappers the model might add', () => {
    const raw = '```\nfeat: add login page\n```';
    expect(cleanCommitMessage(raw)).toBe('feat: add login page');
  });

  it('strips language-annotated fences', () => {
    const raw = '```text\nfix(auth): handle token expiry\n```';
    expect(cleanCommitMessage(raw)).toBe('fix(auth): handle token expiry');
  });

  it('trims surrounding whitespace', () => {
    expect(cleanCommitMessage('  chore: update deps  \n')).toBe('chore: update deps');
  });

  it('preserves multi-line commit messages', () => {
    const msg = 'feat: add search\n\nAdds full-text search to the dashboard.';
    expect(cleanCommitMessage(msg)).toBe(msg);
  });
});

// ── runCommit ─────────────────────────────────────────────────────────────────

const FAKE_DIFF = 'diff --git a/src/index.ts b/src/index.ts\n+console.log("hello");';
const FAKE_MESSAGE = 'feat(index): add hello log';

/**
 * Stubs execFile with a callback-style mock that works with node:util promisify.
 * Each entry in `responses` maps an args-substring to a stdout value (or Error).
 */
function mockExecSequence(responses: Array<{ match: string; result: { stdout: string } | Error }>) {
  execFileMock.mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, res?: { stdout: string }) => void) => {
      const entry = responses.find((r) => args.includes(r.match));
      if (!entry) {
        cb(null, { stdout: '' });
        return;
      }
      if (entry.result instanceof Error) {
        cb(entry.result);
      } else {
        cb(null, entry.result);
      }
    }
  );
}

function setupHappyPath() {
  (getWorkspaceRoot as ReturnType<typeof vi.fn>).mockResolvedValue('/repo');
  (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue({});
  (getActiveProfile as ReturnType<typeof vi.fn>).mockReturnValue({
    model: 'gpt-4o',
    temperature: 0.2,
    maxTokens: 256,
    systemPrompt: undefined,
  });
  (createProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
    streamCompletion: vi.fn(),
  });
  (collectStream as ReturnType<typeof vi.fn>).mockResolvedValue({ text: FAKE_MESSAGE });

  mockExecSequence([
    { match: '--staged', result: { stdout: FAKE_DIFF } },
    { match: 'show',     result: { stdout: FAKE_DIFF } },
    { match: 'commit',   result: { stdout: '' } },
  ]);
}

describe('runCommit', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as (code?: number) => never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('prints the generated message to stdout in --dry mode without committing', async () => {
    setupHappyPath();
    await runCommit({ dry: true });

    // The message should have been written to stdout
    const stdoutCalls = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stdoutCalls).toContain(FAKE_MESSAGE);

    // No git commit should have been executed
    const gitCommitCalled = execFileMock.mock.calls.some((c) =>
      Array.isArray(c[1]) && c[1].includes('commit')
    );
    expect(gitCommitCalled).toBe(false);

    // "Dry run" notice on stderr
    const stderrOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderrOutput).toContain('Dry run');
  });

  it('calls git commit -m with the generated message when --yes is set', async () => {
    setupHappyPath();
    await runCommit({ yes: true });

    const commitCall = execFileMock.mock.calls.find((c) =>
      Array.isArray(c[1]) && c[1].includes('commit')
    );
    expect(commitCall).toBeDefined();
    expect(commitCall![1]).toContain('-m');
    expect(commitCall![1]).toContain(FAKE_MESSAGE);
    expect(printSuccess).toHaveBeenCalledWith(expect.stringContaining('Commit created'));
  });

  it('appends --amend to the git commit command when the flag is set', async () => {
    setupHappyPath();
    await runCommit({ yes: true, amend: true });

    const commitCall = execFileMock.mock.calls.find((c) =>
      Array.isArray(c[1]) && c[1].includes('commit')
    );
    expect(commitCall).toBeDefined();
    expect(commitCall![1]).toContain('--amend');
    expect(printSuccess).toHaveBeenCalledWith(expect.stringContaining('amended'));
  });

  it('calls printError and exits when there are no staged changes', async () => {
    (getWorkspaceRoot as ReturnType<typeof vi.fn>).mockResolvedValue('/repo');
    mockExecSequence([{ match: '--staged', result: { stdout: '' } }]);

    await expect(runCommit({})).rejects.toThrow('process.exit called');
    expect(printError).toHaveBeenCalledWith(expect.stringContaining('No staged changes'));
  });

  it('calls printError and exits when the model returns an empty message', async () => {
    setupHappyPath();
    (collectStream as ReturnType<typeof vi.fn>).mockResolvedValue({ text: '' });

    await expect(runCommit({ yes: true })).rejects.toThrow('process.exit called');
    expect(printError).toHaveBeenCalledWith(expect.stringContaining('did not produce'));
  });

  it('calls printError and exits when git diff --staged throws', async () => {
    (getWorkspaceRoot as ReturnType<typeof vi.fn>).mockResolvedValue('/repo');
    mockExecSequence([
      { match: '--staged', result: new Error('not a git repository') },
    ]);

    await expect(runCommit({})).rejects.toThrow('process.exit called');
    expect(printError).toHaveBeenCalledWith(expect.stringContaining('git diff'));
  });
});
