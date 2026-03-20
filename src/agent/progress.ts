import type { ProgressEvent } from './orchestrator.js';

export type OutputMode = 'interactive' | 'default' | 'quiet' | 'json';

export class ProgressReporter {
  private mode: OutputMode;
  private write: (msg: string) => void;
  private events: ProgressEvent[] = [];
  private completed = 0;
  private total = 0;
  private activeWorkers = 0;
  private totalTokens = 0;

  constructor(mode: OutputMode, write: (msg: string) => void = (msg) => process.stderr.write(msg)) {
    this.mode = mode;
    this.write = write;
  }

  onEvent(event: ProgressEvent): void {
    this.events.push(event);

    if (this.mode === 'quiet') return;
    if (this.mode === 'json') return; // collected, rendered at end

    switch (event.type) {
      case 'plan-ready': {
        // Extract total from message
        const match = event.message.match(/(\d+) subtasks/);
        if (match) this.total = parseInt(match[1], 10);
        this.write(`\n${this.formatPlanReady(event.message)}\n`);
        break;
      }
      case 'worker-started':
        this.activeWorkers++;
        this.write(`${this.formatWorkerPrefix(event.subtaskId)} ${event.message}\n`);
        break;
      case 'worker-completed':
        this.activeWorkers--;
        this.completed++;
        this.write(`${this.formatWorkerPrefix(event.subtaskId)} ${event.message}\n`);
        this.write(this.formatStatusBar() + '\n');
        break;
      case 'worker-failed':
        this.activeWorkers--;
        this.write(`${this.formatWorkerPrefix(event.subtaskId)} ${event.message}\n`);
        break;
      case 'all-done':
        this.write(`\n${event.message}\n`);
        break;
    }
  }

  updateTokenCount(tokens: number): void {
    this.totalTokens = tokens;
  }

  /** For --json mode: return all events as structured data */
  getJsonResults(): ProgressEvent[] {
    return [...this.events];
  }

  private formatWorkerPrefix(subtaskId?: string): string {
    return subtaskId ? `[Worker ${subtaskId}]` : '[Agent]';
  }

  private formatPlanReady(message: string): string {
    return `--- ${message} ---`;
  }

  private formatStatusBar(): string {
    return `[${this.completed}/${this.total} subtasks complete | ${this.activeWorkers} active | ${this.totalTokens.toLocaleString()} tokens]`;
  }
}

/** Create a ProgressReporter from CLI options */
export function createProgressReporter(options: { quiet?: boolean; json?: boolean }): ProgressReporter {
  if (options.json) return new ProgressReporter('json');
  if (options.quiet) return new ProgressReporter('quiet');
  const isTTY = process.stdout.isTTY;
  return new ProgressReporter(isTTY ? 'interactive' : 'default');
}
