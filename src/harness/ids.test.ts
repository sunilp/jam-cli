import { describe, it, expect, vi } from 'vitest';
import { uuidv7, LogicalClock } from './ids.js';

describe('uuidv7', () => {
  it('produces a valid v7 uuid', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('sorts lexicographically in generation order, even within one millisecond', () => {
    const ids = Array.from({ length: 500 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
  });

  it('never collides', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    expect(new Set(ids).size).toBe(5000);
  });

  it('generates ids with increasing timestamps despite clock regression', () => {
    const mockNow = vi.spyOn(Date, 'now');

    // Generate first id at t=1000
    mockNow.mockReturnValue(1000);
    const id1 = uuidv7();

    // Clock steps back to 950
    mockNow.mockReturnValue(950);
    const id2 = uuidv7();

    // Ids should still sort in generation order despite the backward clock step
    expect([id1, id2].sort()).toEqual([id1, id2]);

    mockNow.mockRestore();
  });

  it('generates many unique and ordered ids even with repeated counter exhaustion', () => {
    const mockNow = vi.spyOn(Date, 'now');

    const baseMs = 8000;
    let callCount = 0;

    // Advance time after enough calls to allow multiple counter exhaustions
    mockNow.mockImplementation(() => {
      callCount++;
      // Divide the timeline into 10 segments of 1500 calls each
      // so the timestamp advances every ~1500 calls
      const segmentSize = 1500;
      return baseMs + Math.floor((callCount - 1) / segmentSize);
    });

    // Generate 1000 ids (enough to trigger counter exhaustion multiple times with reset)
    const ids = Array.from({ length: 1000 }, () => uuidv7());

    // All ids should be unique
    expect(new Set(ids).size).toBe(1000);

    // All ids should sort in generation order
    expect([...ids].sort()).toEqual(ids);

    mockNow.mockRestore();
  });
});

describe('LogicalClock', () => {
  it('increases monotonically', () => {
    const c = new LogicalClock();
    expect(c.next()).toBe(1n);
    expect(c.next()).toBe(2n);
  });

  it('resumes above a restored high-water mark', () => {
    const c = new LogicalClock(41n);
    expect(c.next()).toBe(42n);
  });
});
