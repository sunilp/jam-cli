import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRecorder } from './recorder.js';
import type { SessionStep } from './types.js';

describe('SessionRecorder', () => {
  let recorder: SessionRecorder;

  beforeEach(() => {
    recorder = new SessionRecorder({ name: 'test-session', startUrl: 'https://example.com' });
  });

  describe('record', () => {
    it('should record a step with auto-incrementing index', () => {
      recorder.record('browser_navigate', { url: 'https://example.com' }, 'https://example.com');
      recorder.record('browser_click', { element: '#btn' }, 'https://example.com');

      const steps = recorder.getSteps();
      expect(steps).toHaveLength(2);
      expect(steps[0].index).toBe(0);
      expect(steps[0].action).toBe('browser_navigate');
      expect(steps[1].index).toBe(1);
      expect(steps[1].action).toBe('browser_click');
    });

    it('should include a timestamp on each step', () => {
      recorder.record('browser_navigate', { url: 'https://example.com' }, 'https://example.com');

      const steps = recorder.getSteps();
      expect(steps[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('pause/resume', () => {
    it('should not record steps while paused', () => {
      recorder.record('browser_navigate', { url: 'https://a.com' }, 'https://a.com');
      recorder.pause();
      recorder.record('browser_click', { element: '#x' }, 'https://a.com');
      recorder.resume();
      recorder.record('browser_click', { element: '#y' }, 'https://a.com');

      const steps = recorder.getSteps();
      expect(steps).toHaveLength(2);
      expect(steps[0].action).toBe('browser_navigate');
      expect(steps[1].action).toBe('browser_click');
      expect(steps[1].args).toEqual({ element: '#y' });
    });
  });

  describe('annotate', () => {
    it('should add a note to the last step', () => {
      recorder.record('browser_click', { element: '#btn' }, 'https://example.com');
      recorder.annotate('Clicked the submit button');

      const steps = recorder.getSteps();
      expect(steps[0].note).toBe('Clicked the submit button');
    });

    it('should do nothing if no steps exist', () => {
      expect(() => recorder.annotate('note')).not.toThrow();
    });
  });

  describe('toSessionFile', () => {
    it('should produce a valid SessionFile', () => {
      recorder.record('browser_navigate', { url: 'https://example.com' }, 'https://example.com');

      const file = recorder.toSessionFile();

      expect(file.version).toBe(1);
      expect(file.metadata.name).toBe('test-session');
      expect(file.metadata.startUrl).toBe('https://example.com');
      expect(file.metadata.steps).toBe(1);
      expect(file.steps).toHaveLength(1);
    });

    it('should compute duration from first to last step', () => {
      vi.useFakeTimers();
      const now = new Date('2026-03-26T10:00:00Z');
      vi.setSystemTime(now);

      recorder.record('browser_navigate', { url: 'https://a.com' }, 'https://a.com');

      vi.setSystemTime(new Date('2026-03-26T10:00:45Z'));
      recorder.record('browser_click', { element: '#x' }, 'https://a.com');

      const file = recorder.toSessionFile();
      expect(file.metadata.duration).toBe('45s');

      vi.useRealTimers();
    });
  });

  describe('isPaused', () => {
    it('should reflect pause state', () => {
      expect(recorder.isPaused()).toBe(false);
      recorder.pause();
      expect(recorder.isPaused()).toBe(true);
      recorder.resume();
      expect(recorder.isPaused()).toBe(false);
    });
  });
});
