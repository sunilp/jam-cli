import { loadSqlite, type DatabaseSyncType } from './sqlite.js';
import { uuidv7, LogicalClock } from './ids.js';
import type { JournalEvent, RuntimeEvent, Requirement } from './events.js';

export interface SessionRow {
  id: string; cwd: string; task: string; state: string;
  createdAt: number; updatedAt: number;
}

export class Journal {
  private readonly db: DatabaseSyncType;
  private readonly clocks = new Map<string, LogicalClock>();

  constructor(path: string) {
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');  // node:sqlite has no db.pragma()
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, cwd TEXT NOT NULL, task TEXT NOT NULL,
        state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        parent_event_id TEXT,
        logical_clock INTEGER NOT NULL,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session
        ON events(session_id, logical_clock);
    `);
  }

  createSession(input: { task: string; cwd: string; requirements: Requirement[] }): string {
    const id = uuidv7();
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO sessions (id, cwd, task, state, created_at, updated_at)
       VALUES (?, ?, ?, 'created', ?, ?)`
    ).run(id, input.cwd, input.task, now, now);

    // Requirements are snapshotted here and are immutable for the session.
    // The verifier reads this snapshot, never the file on disk. See spec 9.3.
    this.append(id, {
      type: 'session.created',
      task: input.task,
      cwd: input.cwd,
      requirements: input.requirements,
    });
    return id;
  }

  private clockFor(sessionId: string): LogicalClock {
    let c = this.clocks.get(sessionId);
    if (!c) {
      const row = this.db
        .prepare(`SELECT MAX(logical_clock) AS hw FROM events WHERE session_id = ?`)
        .get(sessionId) as { hw: number | null };
      c = new LogicalClock(BigInt(row.hw ?? 0));
      this.clocks.set(sessionId, c);
    }
    return c;
  }

  append(sessionId: string, event: RuntimeEvent, parentEventId?: string): JournalEvent {
    const entry: JournalEvent = {
      id: uuidv7(),
      sessionId,
      parentEventId,
      logicalClock: this.clockFor(sessionId).next(),
      at: Date.now(),
      event,
    };
    this.db.prepare(
      `INSERT INTO events (id, session_id, parent_event_id, logical_clock, at, type, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.id, entry.sessionId, entry.parentEventId ?? null,
      Number(entry.logicalClock), entry.at, event.type, JSON.stringify(event)
    );
    this.db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(entry.at, sessionId);
    return entry;
  }

  replay(sessionId: string): JournalEvent[] {
    const rows = this.db.prepare(
      `SELECT * FROM events WHERE session_id = ? ORDER BY logical_clock ASC`
    ).all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: r['id'] as string,
      sessionId: r['session_id'] as string,
      parentEventId: (r['parent_event_id'] as string | null) ?? undefined,
      logicalClock: BigInt(r['logical_clock'] as number),
      at: r['at'] as number,
      event: JSON.parse(r['payload'] as string) as RuntimeEvent,
    }));
  }

  /** Accepts any SessionState; the journal does not constrain the vocabulary. */
  setState(sessionId: string, state: string): void {
    this.db.prepare(`UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?`)
      .run(state, Date.now(), sessionId);
  }

  listSessions(): SessionRow[] {
    const rows = this.db.prepare(
      `SELECT id, cwd, task, state, created_at, updated_at FROM sessions
       ORDER BY updated_at DESC`
    ).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r['id'] as string, cwd: r['cwd'] as string, task: r['task'] as string,
      state: r['state'] as string,
      createdAt: r['created_at'] as number, updatedAt: r['updated_at'] as number,
    }));
  }

  close(): void { this.db.close(); }
}
