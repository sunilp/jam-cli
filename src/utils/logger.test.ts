import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from './logger.js';

describe('Logger', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('logs at or below the configured level', () => {
    const logger = new Logger('info');
    logger.error('error message');
    logger.warn('warn message');
    logger.info('info message');
    logger.debug('debug message');

    const output = stderrSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(output).toContain('error message');
    expect(output).toContain('warn message');
    expect(output).toContain('info message');
    expect(output).not.toContain('debug message');
  });

  it('suppresses all output at silent level', () => {
    const logger = new Logger('silent');
    logger.error('should not appear');
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('redacts secrets matching patterns', () => {
    const logger = new Logger('info', ['sk-[a-z0-9]+', 'password=\\S+']);
    logger.info('my api key is sk-abc123def456 ok?');
    logger.info('login with password=supersecret now');

    const output = stderrSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(output).not.toContain('sk-abc123def456');
    expect(output).not.toContain('supersecret');
    expect(output).toContain('[REDACTED]');
  });

  it('redacts in extra args too', () => {
    const logger = new Logger('info', ['secret']);
    logger.info('metadata:', 'secret value here');

    const output = stderrSpy.mock.calls.map((c) => c[0] as string).join('');
    expect(output).not.toContain('secret value here');
    expect(output).toContain('[REDACTED]');
  });

  it('writes to stderr not stdout', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = new Logger('info');
    logger.info('test');
    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});
