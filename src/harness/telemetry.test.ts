import { describe, it, expect } from 'vitest';
import { RingTelemetry } from './telemetry.js';

describe('RingTelemetry', () => {
  it('retains only the most recent events', () => {
    const t = new RingTelemetry(3);
    for (let i = 0; i < 10; i++) t.write({ kind: 'model.delta', text: `${i}` });
    expect(t.recent().map((e) => (e as { text: string }).text)).toEqual(['7', '8', '9']);
  });

  it('is droppable without error', () => {
    const t = new RingTelemetry(3);
    t.write({ kind: 'model.delta', text: 'x' });
    t.drop();
    expect(t.recent()).toEqual([]);
  });
});
