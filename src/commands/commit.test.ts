import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

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
  blockIfEmbedded: vi.fn(),
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
  let processExitSpy: MockInstance<[code?: string | number | null | undefined], never>;
  let stderrSpy: MockInstance<[str: string | Uint8Array, encoding?: BufferEncoding, cb?: (err?: Error | null) => void], boolean>;
  let stdoutSpy: MockInstance<[str: string | Uint8Array, encoding?: BufferEncoding, cb?: (err?: Error | null) => void], boolean>;

  beforeEach(() => {
    vi.clearAllMocks();
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error('process.exit called');
    });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true) as typeof stderrSpy;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true) as typeof stdoutSpy;
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
    expect(printError).toHaveBeenCalledWith(expect.stringContaining('git diff'), expect.anything());
  });
});

// ── Tests for convention detection and prompt building (pure functions) ──────
// These use the real (unmocked) module via dynamic import inside each test.

describe('buildCommitSystemPrompt', () => {
  it('builds prompt with explicit config convention', async () => {
    const { buildCommitSystemPrompt } = await import('./commit.js');
    const prompt = buildCommitSystemPrompt(
      { format: '{ticket}: {type}: {description}', ticketPattern: 'PROJ-\\d+', ticketRequired: true },
      null,
      false,
    );
    expect(prompt).toContain('{ticket}: {type}: {description}');
    expect(prompt).toContain('Ticket is REQUIRED');
    expect(prompt).toContain('PROJ-\\d+');
  });

  it('builds prompt from detected convention', async () => {
    const { buildCommitSystemPrompt } = await import('./commit.js');
    const prompt = buildCommitSystemPrompt(
      undefined,
      {
        format: '{ticket}: {description}',
        ticketPattern: '[A-Z]{2,10}-\\d+',
        types: ['feat', 'fix'],
        examples: ['JIRA-123: add login page', 'JIRA-456: fix button alignment'],
      },
      false,
    );
    expect(prompt).toContain('{ticket}: {description}');
    expect(prompt).toContain('JIRA-123: add login page');
    expect(prompt).toContain('feat, fix');
  });

  it('falls back to defaults when no convention', async () => {
    const { buildCommitSystemPrompt } = await import('./commit.js');
    const prompt = buildCommitSystemPrompt(undefined, null, false);
    expect(prompt).toContain('<type>(<scope>): <short description>');
  });

  it('produces compact prompt for small models', async () => {
    const { buildCommitSystemPrompt } = await import('./commit.js');
    const prompt = buildCommitSystemPrompt(
      { format: '{ticket}: {description}' },
      null,
      true,
    );
    expect(prompt).toContain('under 72 characters');
    expect(prompt).not.toContain('Placeholders');
  });

  it('includes custom rules from config', async () => {
    const { buildCommitSystemPrompt } = await import('./commit.js');
    const prompt = buildCommitSystemPrompt(
      { rules: ['Always reference the module name in scope', 'Use past tense for descriptions'] },
      null,
      false,
    );
    expect(prompt).toContain('Always reference the module name in scope');
    expect(prompt).toContain('Use past tense for descriptions');
  });
});

describe('cleanCommitMessage — ticket patterns', () => {
  it('extracts JIRA-prefixed commit message', async () => {
    const { cleanCommitMessage } = await import('./commit.js');
    const result = cleanCommitMessage('Here is the commit message:\n\nPROJ-123: add user auth flow');
    expect(result).toBe('PROJ-123: add user auth flow');
  });

  it('extracts bracket-ticket commit message', async () => {
    const { cleanCommitMessage } = await import('./commit.js');
    const result = cleanCommitMessage('Based on the diff:\n[TEAM-456] fix null pointer in handler');
    expect(result).toBe('[TEAM-456] fix null pointer in handler');
  });

  it('still extracts conventional commits', async () => {
    const { cleanCommitMessage } = await import('./commit.js');
    const result = cleanCommitMessage('The commit message is:\nfeat(auth): add OAuth2 support');
    expect(result).toBe('feat(auth): add OAuth2 support');
  });
});
