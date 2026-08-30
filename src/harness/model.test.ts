import { describe, it, expect } from 'vitest';
import { MockProvider } from './model.js';
import { RingTelemetry } from './telemetry.js';

describe('MockProvider', () => {
  it('replays scripted turns in order', async () => {
    const p = new MockProvider([
      { content: null, toolCalls: [{ id: '1', name: 'read_file', arguments: { path: 'a' } }] },
      { content: 'done', toolCalls: [] },
    ]);
    const signal = new AbortController().signal;
    const first = await p.generate({ messages: [], tools: [] }, signal);
    expect(first.toolCalls[0]?.name).toBe('read_file');
    const second = await p.generate({ messages: [], tools: [] }, signal);
    expect(second.toolCalls).toEqual([]);
    expect(second.content).toBe('done');
  });

  it('sends deltas to telemetry, not to the caller', async () => {
    const t = new RingTelemetry();
    const p = new MockProvider([{ content: 'hi', toolCalls: [], deltas: ['h', 'i'] }], t);
    const res = await p.generate({ messages: [], tools: [] }, new AbortController().signal);

    expect(t.recent()).toEqual([
      { kind: 'model.delta', text: 'h' },
      { kind: 'model.delta', text: 'i' },
    ]);
    // Without this the test passes against an implementation that ALSO leaks
    // the deltas into the returned content, which would put streamed tokens
    // into the durable journal — the thing the telemetry split exists to stop.
    expect(res.content).toBe('hi');
  });

  it('reports exhaustion as unrecoverable rather than looping forever', async () => {
    const p = new MockProvider([]);
    const r = await p.generate({ messages: [], tools: [] }, new AbortController().signal);
    expect(r.unrecoverable).toBe(true);
  });
});
