import { describe, it, expect } from 'vitest';
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
