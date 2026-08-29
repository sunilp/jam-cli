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

  it('cannot grow without bound', () => {
    const t = new RingTelemetry(50);
    for (let i = 0; i < 100_000; i++) t.write({ kind: 'model.delta', text: `${i}` });
    expect(t.recent().length).toBe(50);
    expect((t.recent().at(-1) as { text: string }).text).toBe('99999');
  });

  it('handles a capacity of 1', () => {
    const t = new RingTelemetry(1);
    t.write({ kind: 'model.delta', text: 'a' });
    t.write({ kind: 'model.delta', text: 'b' });
    expect(t.recent()).toEqual([{ kind: 'model.delta', text: 'b' }]);
  });
});
