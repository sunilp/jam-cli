import type { SessionStep, SessionFile, SessionMetadata } from './types.js';

export interface RecorderOptions {
  name: string;
  startUrl: string;
}

export class SessionRecorder {
  private steps: SessionStep[] = [];
  private paused = false;
  private name: string;
  private startUrl: string;
  private createdAt: string;

  constructor(options: RecorderOptions) {
    this.name = options.name;
    this.startUrl = options.startUrl;
    this.createdAt = new Date().toISOString();
  }

  record(action: string, args: Record<string, unknown>, url: string): void {
    if (this.paused) return;
    this.steps.push({
      index: this.steps.length,
      action,
      args,
      timestamp: new Date().toISOString(),
      url,
    });
  }

  annotate(note: string): void {
    const last = this.steps[this.steps.length - 1];
    if (last) last.note = note;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  getSteps(): readonly SessionStep[] {
    return this.steps;
  }

  toSessionFile(): SessionFile {
    const duration = this.computeDuration();
    const metadata: SessionMetadata = {
      name: this.name,
      createdAt: this.createdAt,
      startUrl: this.startUrl,
      steps: this.steps.length,
      duration,
    };
    return { version: 1, metadata, steps: [...this.steps] };
  }

  private computeDuration(): string {
    if (this.steps.length < 2) return '0s';
    const first = new Date(this.steps[0]!.timestamp).getTime();
    const last = new Date(this.steps[this.steps.length - 1]!.timestamp).getTime();
    const seconds = Math.round((last - first) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }
}
