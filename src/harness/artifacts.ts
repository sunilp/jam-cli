import { DatabaseSync, type DatabaseSyncType } from './sqlite.js';
import { createHash } from 'node:crypto';

export interface ArtifactRef { digest: string; size: number }

const ERROR_LINE = /\b(error|exception|failed|failure|panic|traceback|fatal)\b/i;

export class ArtifactStore {
  private readonly db: DatabaseSyncType;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        digest TEXT PRIMARY KEY, size INTEGER NOT NULL,
        media_type TEXT, created_at INTEGER NOT NULL, body TEXT NOT NULL
      );
    `);
  }

  put(content: string, mediaType = 'text/plain'): ArtifactRef {
    const digest = createHash('sha256').update(content).digest('hex');
    const size = Buffer.byteLength(content);
    this.db.prepare(
      `INSERT OR IGNORE INTO artifacts (digest, size, media_type, created_at, body)
       VALUES (?, ?, ?, ?, ?)`
    ).run(digest, size, mediaType, Date.now(), content);
    return { digest, size };
  }

  get(digest: string): string | undefined {
    const row = this.db.prepare(`SELECT body FROM artifacts WHERE digest = ?`).get(digest) as
      | { body: string } | undefined;
    return row?.body;
  }

  close(): void { this.db.close(); }
}

/**
 * What the model sees instead of a 7MB test log: head, tail, and any line that
 * looks like an error. The full output stays in the artifact store.
 */
export function preview(
  content: string,
  opts: { head?: number; tail?: number } = {}
): string {
  const head = opts.head ?? 40;
  const tail = opts.tail ?? 40;
  const lines = content.split('\n');
  if (lines.length <= head + tail) return content;

  const headLines = lines.slice(0, head);
  const tailLines = lines.slice(-tail);
  const middle = lines.slice(head, lines.length - tail);
  const errors = middle.filter((l) => ERROR_LINE.test(l)).slice(0, 20);

  const parts = [
    ...headLines,
    `… ${middle.length} lines elided …`,
    ...(errors.length ? ['--- error lines ---', ...errors] : []),
    ...tailLines,
  ];
  return parts.join('\n');
}
