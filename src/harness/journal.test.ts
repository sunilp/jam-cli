import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from './journal.js';

let j: Journal;
beforeEach(() => { j = new Journal(':memory:'); });
afterEach(() => { j.close(); });

describe('Journal', () => {
  it('appends and replays in logical clock order', () => {
    const s = j.createSession({ task: 't', cwd: '/w', requirements: [] });
    j.append(s, { type: 'user.message', content: 'one' });
    j.append(s, { type: 'user.message', content: 'two' });

    const events = j.replay(s);
    // session.created is written by createSession
    expect(events.map((e) => e.event.type)).toEqual([
      'session.created', 'user.message', 'user.message',
    ]);
    expect(events[1]!.logicalClock).toBeLessThan(events[2]!.logicalClock);
  });

  it('assigns sortable uuidv7 ids', () => {
    const s = j.createSession({ task: 't', cwd: '/w', requirements: [] });
    j.append(s, { type: 'user.message', content: 'a' });
    const ids = j.replay(s).map((e) => e.id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('isolates sessions', () => {
    const a = j.createSession({ task: 'a', cwd: '/w', requirements: [] });
    const b = j.createSession({ task: 'b', cwd: '/w', requirements: [] });
    j.append(a, { type: 'user.message', content: 'only-a' });
    expect(j.replay(b).length).toBe(1);
  });

  it('rebuilds the logical clock from the stored high-water mark on reopen', () => {
    // A :memory: database is private to one DatabaseSync connection, so the
    // only way to exercise the restore path for real is a file-backed db:
    // write with one Journal, close it, then open a second Journal (whose
    // in-memory `clocks` cache starts empty) on the same file and confirm
    // clockFor() rebuilds from MAX(logical_clock) instead of restarting at 0.
    const dbPath = join(tmpdir(), `jam-journal-test-${randomUUID()}.sqlite`);
    try {
      const first = new Journal(dbPath);
      const s = first.createSession({ task: 't', cwd: '/w', requirements: [] });
      first.append(s, { type: 'user.message', content: 'a' });
      const before = first.replay(s).at(-1)!.logicalClock;
      first.close();

      const reopened = new Journal(dbPath);
      const resumed = reopened.append(s, { type: 'user.message', content: 'b' });
      expect(resumed.logicalClock).toBeGreaterThan(before);
      expect(reopened.replay(s).at(-1)!.logicalClock).toBeGreaterThan(before);
      reopened.close();
    } finally {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });

  it('snapshots verification requirements into session.created', () => {
    const s = j.createSession({
      task: 't', cwd: '/w',
      requirements: [{ command: 'npm test', mustExit: 0 }],
    });
    const created = j.replay(s)[0]!;
    expect(created.event).toMatchObject({
      type: 'session.created',
      requirements: [{ command: 'npm test', mustExit: 0 }],
    });
  });
});
