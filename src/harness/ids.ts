import { randomBytes } from 'node:crypto';

let lastMs = 0;
let counter = 0;

/**
 * UUIDv7: 48-bit big-endian timestamp, version 7, then randomness.
 * Within one millisecond a 12-bit counter preserves generation order, so ids
 * sort lexicographically. Positional sequence numbers are deliberately not
 * used anywhere in the journal — see spec section 5.1.
 */
export function uuidv7(): string {
  const now = Date.now();
  if (now === lastMs) {
    counter += 1;
    if (counter > 0xfff) {
      // Exhausted this millisecond's counter space; wait for the next tick.
      while (Date.now() === lastMs) { /* spin, sub-millisecond */ }
      return uuidv7();
    }
  } else {
    lastMs = now;
    counter = 0;
  }

  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = 0x70 | ((counter >> 8) & 0x0f);
  b[7] = counter & 0xff;
  b[8] = 0x80 | (b[8]! & 0x3f);

  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Ordering without positional identity. Restored from the journal's max on resume. */
export class LogicalClock {
  private value: bigint;
  constructor(startAt = 0n) {
    this.value = startAt;
  }
  next(): bigint {
    this.value += 1n;
    return this.value;
  }
}
