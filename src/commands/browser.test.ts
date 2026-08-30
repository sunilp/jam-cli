import { describe, it, expect, vi } from 'vitest';
import type * as fs from 'node:fs';
import type * as readline from 'node:readline';

vi.mock('../browser/session.js', () => ({
  BrowserSession: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    processCommand: vi.fn().mockResolvedValue({ response: 'Done', toolCalls: [] }),
    handleSlashCommand: vi.fn().mockResolvedValue('exit'),
    getCurrentUrl: vi.fn().mockReturnValue('https://example.com'),
    getBridge: vi.fn(),
  })),
}));

vi.mock('../browser/recorder.js', () => ({
  SessionRecorder: vi.fn().mockImplementation(() => ({
    record: vi.fn(),
    annotate: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    isPaused: vi.fn().mockReturnValue(false),
    getSteps: vi.fn().mockReturnValue([]),
    toSessionFile: vi.fn().mockReturnValue({
      version: 1,
      metadata: { name: 'test', createdAt: '2026-01-01', startUrl: '', steps: 0, duration: '0s' },
      steps: [],
    }),
  })),
}));

vi.mock('../ui/renderer.js', () => ({
  renderMarkdown: vi.fn(),
  printError: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, writeFileSync: vi.fn(), mkdirSync: vi.fn() };
});

vi.mock('node:readline', async (importOriginal) => {
  const actual = await importOriginal<typeof readline>();
  return {
    ...actual,
    createInterface: vi.fn().mockImplementation(() => ({
      prompt: vi.fn(),
      on: vi.fn().mockImplementation((event: string, cb: () => void) => {
        if (event === 'close') setTimeout(cb, 0);
        return { prompt: vi.fn(), on: vi.fn() };
      }),
      close: vi.fn(),
    })),
  };
});

import { BrowserSession } from '../browser/session.js';

describe('browser commands', () => {
  it('should create a BrowserSession with provided options', async () => {
    const { runBrowserLaunch } = await import('./browser.js');

    await runBrowserLaunch({ url: 'https://example.com' });

    expect(BrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com' }),
    );
  });
});
