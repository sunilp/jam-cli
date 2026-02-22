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
}));

vi.mock('../utils/stream.js', () => ({
  withRetry: vi.fn((fn: () => unknown) => fn()),
  collectStream: vi.fn(),
}));

vi.mock('../ui/renderer.js', () => ({
  streamToStdout: vi.fn(),
  printJsonResult: vi.fn(),
  printError: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { getWorkspaceRoot } from '../utils/workspace.js';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { collectStream } from '../utils/stream.js';
import { streamToStdout, printJsonResult, printError } from '../ui/renderer.js';
import {
  buildReviewPrompt,
  getBranchDiff,
  getMergeBase,
  getPrDiff,
  getCurrentBranch,
  runReview,
} from './review.js';

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

// ── Helpers ───────────────────────────────────────────────────────────────────

const FAKE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts\n+export const x = 1;`;
const FAKE_MERGE_BASE = 'abc1234';

/**
 * Stubs execFile with a callback-style mock compatible with promisify.
 */
function mockExecSequence(
  responses: Array<{ match: string | ((args: string[]) => boolean); result: { stdout: string } | Error }>
) {
  execFileMock.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb: (err: Error | null, res?: { stdout: string }) => void
    ) => {
      const entry = responses.find((r) =>
        typeof r.match === 'function' ? r.match(args) : args.includes(r.match)
      );
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
    maxTokens: 1024,
    systemPrompt: undefined,
  });
  (createProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
    streamCompletion: vi.fn(),
  });
  (streamToStdout as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (collectStream as ReturnType<typeof vi.fn>).mockResolvedValue({
    text: 'Review result',
    usage: { promptTokens: 10, completionTokens: 20 },
  });

  mockExecSequence([
    { match: 'merge-base', result: { stdout: FAKE_MERGE_BASE } },
    { match: '--abbrev-ref', result: { stdout: 'feature/my-branch' } },
    {
      match: (args) => args.includes(FAKE_MERGE_BASE) && args.includes('HEAD'),
      result: { stdout: FAKE_DIFF },
    },
  ]);
}

// ── buildReviewPrompt ─────────────────────────────────────────────────────────

describe('buildReviewPrompt', () => {
  it('includes the diff in a fenced code block', () => {
    const prompt = buildReviewPrompt('diff content', 'context info');
    expect(prompt).toContain('```diff\ndiff content\n```');
  });

  it('includes the context string', () => {
    const prompt = buildReviewPrompt('diff content', 'Reviewing branch "feat" vs "main".');
    expect(prompt).toContain('Reviewing branch "feat" vs "main".');
  });

  it('asks for summary, issues, and suggestions', () => {
    const prompt = buildReviewPrompt('', '');
    expect(prompt).toContain('Summary');
    expect(prompt).toContain('Potential Issues');
    expect(prompt).toContain('Suggestions');
  });
});

// ── getMergeBase ──────────────────────────────────────────────────────────────

describe('getMergeBase', () => {
  it('returns the merge-base SHA', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, res: { stdout: string }) => void) => {
        cb(null, { stdout: '  abc1234  \n' });
      }
    );
    const result = await getMergeBase('/repo', 'main');
    expect(result).toBe('abc1234');
  });

  it('throws JamError when git fails', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
        cb(new Error('not a git repo'));
      }
    );
    await expect(getMergeBase('/repo', 'main')).rejects.toThrow('merge-base');
  });
});

// ── getBranchDiff ─────────────────────────────────────────────────────────────

describe('getBranchDiff', () => {
  it('returns trimmed diff output', async () => {
    mockExecSequence([
      { match: 'merge-base', result: { stdout: FAKE_MERGE_BASE } },
      {
        match: (args) => args.includes(FAKE_MERGE_BASE) && args.includes('HEAD'),
        result: { stdout: `  ${FAKE_DIFF}  ` },
      },
    ]);
    const result = await getBranchDiff('/repo', 'main');
    expect(result).toBe(FAKE_DIFF);
  });

  it('throws JamError when git diff fails', async () => {
    mockExecSequence([
      { match: 'merge-base', result: { stdout: FAKE_MERGE_BASE } },
      {
        match: (args) => args.includes(FAKE_MERGE_BASE),
        result: new Error('git exploded'),
      },
    ]);
    await expect(getBranchDiff('/repo', 'main')).rejects.toThrow('diff against');
  });
});

// ── getPrDiff ─────────────────────────────────────────────────────────────────

describe('getPrDiff', () => {
  it('returns the PR diff from gh CLI', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, res: { stdout: string }) => void) => {
        cb(null, { stdout: FAKE_DIFF });
      }
    );
    const result = await getPrDiff('/repo', 42);
    expect(result).toBe(FAKE_DIFF);
  });

  it('throws JamError mentioning gh CLI when it fails', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
        cb(new Error('gh not found'));
      }
    );
    await expect(getPrDiff('/repo', 42)).rejects.toThrow('GitHub CLI');
  });
});

// ── getCurrentBranch ──────────────────────────────────────────────────────────

describe('getCurrentBranch', () => {
  it('returns the current branch name', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (err: null, res: { stdout: string }) => void) => {
        cb(null, { stdout: 'feature/my-branch\n' });
      }
    );
    const result = await getCurrentBranch('/repo');
    expect(result).toBe('feature/my-branch');
  });
});

// ── runReview ─────────────────────────────────────────────────────────────────

describe('runReview', () => {
  let processExitSpy: MockInstance<[code?: string | number | null | undefined], never>;

  beforeEach(() => {
    vi.clearAllMocks();
    processExitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((_code) => { throw new Error('process.exit'); }) as typeof processExitSpy;
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  it('streams a branch review to stdout', async () => {
    setupHappyPath();
    await runReview({ base: 'main' });
    expect(streamToStdout).toHaveBeenCalledOnce();
    expect(printError).not.toHaveBeenCalled();
  });

  it('uses "main" as the default base', async () => {
    setupHappyPath();
    await runReview({});
    // merge-base should have been called with 'main'
    const calls = execFileMock.mock.calls as Array<[string, string[], unknown, unknown]>;
    const mergeBaseCall = calls.find(([, args]) => args.includes('merge-base'));
    expect(mergeBaseCall).toBeDefined();
    expect(mergeBaseCall![1]).toContain('main');
  });

  it('outputs JSON when --json is set', async () => {
    setupHappyPath();
    await runReview({ base: 'main', json: true });
    expect(printJsonResult).toHaveBeenCalledOnce();
    expect(streamToStdout).not.toHaveBeenCalled();
  });

  it('prints nothing to review when the diff is empty', async () => {
    (getWorkspaceRoot as ReturnType<typeof vi.fn>).mockResolvedValue('/repo');
    mockExecSequence([
      { match: 'merge-base', result: { stdout: FAKE_MERGE_BASE } },
      { match: '--abbrev-ref', result: { stdout: 'feature/x' } },
      {
        match: (args) => args.includes(FAKE_MERGE_BASE) && args.includes('HEAD'),
        result: { stdout: '' },
      },
    ]);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runReview({ base: 'main' });
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('No differences'));
    expect(streamToStdout).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('uses gh pr diff when --pr is provided', async () => {
    (getWorkspaceRoot as ReturnType<typeof vi.fn>).mockResolvedValue('/repo');
    (loadConfig as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (getActiveProfile as ReturnType<typeof vi.fn>).mockReturnValue({
      model: 'gpt-4o',
      temperature: 0.2,
      maxTokens: 1024,
      systemPrompt: undefined,
    });
    (createProvider as ReturnType<typeof vi.fn>).mockResolvedValue({ streamCompletion: vi.fn() });
    (streamToStdout as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    execFileMock.mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb: (err: null, res: { stdout: string }) => void) => {
        if (args.includes('diff') && args.includes('42')) {
          cb(null, { stdout: FAKE_DIFF });
        } else {
          cb(null, { stdout: '' });
        }
      }
    );

    await runReview({ pr: 42 });
    expect(streamToStdout).toHaveBeenCalledOnce();
    const calls = execFileMock.mock.calls as Array<[string, string[], unknown, unknown]>;
    const ghCall = calls.find(([cmd]) => cmd === 'gh');
    expect(ghCall).toBeDefined();
    expect(ghCall![1]).toContain('42');
  });

  it('exits with code 1 and prints error on failure', async () => {
    (getWorkspaceRoot as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no workspace'));
    await expect(runReview({})).rejects.toThrow('process.exit');
    expect(printError).toHaveBeenCalled();
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
