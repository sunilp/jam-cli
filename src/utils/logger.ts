type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LOG_LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export class Logger {
  private level: LogLevel;
  private patterns: RegExp[];

  constructor(level: LogLevel = 'warn', redactPatterns: string[] = []) {
    this.level = level;
    this.patterns = redactPatterns.map((p) => new RegExp(p, 'gi'));
  }

  private redact(message: string): string {
    let result = message;
    for (const pattern of this.patterns) {
      result = result.replace(pattern, '[REDACTED]');
    }
    return result;
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] <= LOG_LEVELS[this.level];
  }

  private write(level: LogLevel, prefix: string, message: string, ...args: unknown[]): void {
    if (!this.shouldLog(level)) return;
    const redacted = this.redact(message);
    const extra = args.map((a) => (typeof a === 'string' ? this.redact(a) : a));
    process.stderr.write(`${prefix} ${redacted}${extra.length ? ' ' + extra.join(' ') : ''}\n`);
  }

  error(message: string, ...args: unknown[]): void {
    this.write('error', '[ERROR]', message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.write('warn', '[WARN] ', message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.write('info', '[INFO] ', message, ...args);
  }

  debug(message: string, ...args: unknown[]): void {
    this.write('debug', '[DEBUG]', message, ...args);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }
}

// Singleton logger — configured at startup in src/index.ts
export const logger = new Logger();
