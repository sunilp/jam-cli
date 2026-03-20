import { describe, it, expect, vi } from 'vitest';
import { ProgressReporter } from './progress.js';

describe('ProgressReporter', () => {
  it('formats worker output with prefixes', () => {
    const output: string[] = [];
    const reporter = new ProgressReporter('default', (msg) => output.push(msg));

    reporter.onEvent({ type: 'plan-ready', message: 'Plan: Add API (2 subtasks)' });
    reporter.onEvent({ type: 'worker-started', subtaskId: '1', message: 'Starting: Create model' });
    reporter.onEvent({ type: 'worker-completed', subtaskId: '1', message: 'Done: Create model' });

    expect(output.some(o => o.includes('[Worker 1]'))).toBe(true);
    expect(output.some(o => o.includes('subtasks complete'))).toBe(true);
  });

  it('suppresses output in quiet mode', () => {
    const output: string[] = [];
    const reporter = new ProgressReporter('quiet', (msg) => output.push(msg));

    reporter.onEvent({ type: 'plan-ready', message: 'Plan' });
    reporter.onEvent({ type: 'worker-started', subtaskId: '1', message: 'Starting' });

    expect(output).toHaveLength(0);
  });

  it('collects events for json mode', () => {
    const reporter = new ProgressReporter('json', () => {});

    reporter.onEvent({ type: 'plan-ready', message: 'Plan' });
    reporter.onEvent({ type: 'worker-started', subtaskId: '1', message: 'Starting' });

    const results = reporter.getJsonResults();
    expect(results).toHaveLength(2);
    expect(results[0].type).toBe('plan-ready');
  });

  it('shows status bar after worker completion', () => {
    const output: string[] = [];
    const reporter = new ProgressReporter('default', (msg) => output.push(msg));

    reporter.onEvent({ type: 'plan-ready', message: 'Plan: Test (3 subtasks)' });
    reporter.onEvent({ type: 'worker-started', subtaskId: '1', message: 'Starting' });
    reporter.updateTokenCount(1500);
    reporter.onEvent({ type: 'worker-completed', subtaskId: '1', message: 'Done' });

    const statusBar = output.find(o => o.includes('1/3'));
    expect(statusBar).toBeDefined();
    expect(statusBar).toContain('1,500 tokens');
  });

  it('renders all-done event', () => {
    const output: string[] = [];
    const reporter = new ProgressReporter('default', (msg) => output.push(msg));
    reporter.onEvent({ type: 'all-done', message: 'Completed 2/2 subtasks' });
    expect(output.some(o => o.includes('Completed 2/2'))).toBe(true);
  });
});
