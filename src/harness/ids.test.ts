import { describe, it, expect, vi } from 'vitest';
import { uuidv7, LogicalClock, resetUuidv7State } from './ids.js';

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

  it('writes the wall clock into the 48-bit big-endian timestamp field', () => {
    resetUuidv7State();

    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();

    // The leading 12 hex digits are the 48-bit big-endian timestamp: the field
    // cross-millisecond ordering rests on, so read it back and check the bytes
    // landed in the right order at the right offset.
    const timestamp = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);

    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  it('generates ids with increasing timestamps despite clock regression', () => {
    const mockNow = vi.spyOn(Date, 'now');

    try {
      resetUuidv7State();

      // Generate first id at t=1000
      mockNow.mockReturnValue(1000);
      const id1 = uuidv7();

      // Clock steps back to 950
      mockNow.mockReturnValue(950);
      const id2 = uuidv7();

      // Ids should still sort in generation order despite the backward clock step
      expect([id1, id2].sort()).toEqual([id1, id2]);
    } finally {
      mockNow.mockRestore();
    }
  });

  it('exhausts counter and borrows milliseconds, maintaining order', () => {
    const mockNow = vi.spyOn(Date, 'now');

    try {
      resetUuidv7State();

      // Freeze time at a single constant value
      const frozenMs = 9000;
      mockNow.mockReturnValue(frozenMs);

      // Generate 5000 ids, well past the 4096 counter limit
      // This forces the borrow mechanism to activate multiple times
      const ids = Array.from({ length: 5000 }, () => uuidv7());

      // All ids must be unique
      expect(new Set(ids).size).toBe(5000);

      // All ids must still be in sorted order
      expect([...ids].sort()).toEqual(ids);

      // Verify the borrow actually happened:
      // Extract the 48-bit timestamp from first and last id (first 12 hex chars, no dashes)
      const removeUuidDashes = (uuid: string) => uuid.replace(/-/g, '');
      const firstHex = removeUuidDashes(ids[0]!);
      const lastHex = removeUuidDashes(ids[ids.length - 1]!);
      const firstTimestamp = firstHex.slice(0, 12);
      const lastTimestamp = lastHex.slice(0, 12);

      // The timestamp must have advanced due to borrowing
      // (greater timestamp indicates time borrowed from the future)
      // Convert hex strings to numbers for comparison
      expect(parseInt(lastTimestamp, 16)).toBeGreaterThan(
        parseInt(firstTimestamp, 16)
      );
    } finally {
      mockNow.mockRestore();
    }
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
