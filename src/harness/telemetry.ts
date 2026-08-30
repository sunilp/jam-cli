/**
 * Disposable by construction. Nothing here may be required to reconstruct
 * model-visible history — that is the journal's job. See spec 5.3.
 */
export type TelemetryEvent =
  | { kind: 'model.delta'; text: string }
  | { kind: 'model.reasoning'; text: string }
  | { kind: 'proc.stdout'; callId: string; chunk: string }
  | { kind: 'proc.stderr'; callId: string; chunk: string }
  | { kind: 'ui.progress'; label: string };

export interface TelemetrySink {
  write(e: TelemetryEvent): void;
  drop(): void;
}

export class RingTelemetry implements TelemetrySink {
  private buf: TelemetryEvent[] = [];
  constructor(private readonly capacity = 2000) {}

  write(e: TelemetryEvent): void {
    this.buf.push(e);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
  }

  recent(): TelemetryEvent[] { return [...this.buf]; }
  drop(): void { this.buf = []; }
}

export class NullTelemetry implements TelemetrySink {
  write(): void {}
  drop(): void {}
}
