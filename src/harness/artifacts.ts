import { DatabaseSync, type DatabaseSyncType } from './sqlite.js';
import { createHash } from 'node:crypto';

export interface ArtifactRef { digest: string; size: number }

const ERROR_LINE = /\b(error|exception|failed|failure|panic|traceback|fatal)\b/i;
const MAX_ERROR_LINES = 20;
/** Line counting alone does not bound a single enormous line — and
 *  JSON.stringify turns any multi-line value into exactly one. */
const MAX_CHARS = 8_000;

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

  /** Rows stored for a digest. Exists so the dedup test can assert storage. */
  count(digest: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM artifacts WHERE digest = ?`
    ).get(digest) as { n: number };
    return row.n;
  }

  close(): void { this.db.close(); }
}

/**
 * What the model sees instead of a 7MB test log: head, tail, and any line that
 * looks like an error. The full output stays in the artifact store.
 */
export function preview(
  content: string,
  opts: { head?: number; tail?: number; maxChars?: number } = {}
): string {
  const head = opts.head ?? 40;
  const tail = opts.tail ?? 40;
  const lines = content.split('\n');
  if (lines.length <= head + tail) return clamp(content, opts.maxChars ?? MAX_CHARS);

  const headLines = lines.slice(0, head);
  const tailLines = lines.slice(-tail);
  const middle = lines.slice(head, lines.length - tail);
  const allErrors = middle.filter((l) => ERROR_LINE.test(l));
  const errors = allErrors.slice(0, MAX_ERROR_LINES);
  const dropped = allErrors.length - errors.length;

  const parts = [
    ...headLines,
    `… ${middle.length} lines elided …`,
    ...(errors.length
      ? [
          '--- error lines ---',
          ...errors,
          // Never drop error lines without saying so.
          ...(dropped > 0 ? [`… ${dropped} more error lines omitted …`] : []),
        ]
      : []),
    ...tailLines,
  ];
  return clamp(parts.join('\n'), opts.maxChars ?? MAX_CHARS);
}

/**
 * Hard character ceiling. Without it a single 500KB line — which is exactly
 * what JSON.stringify produces from any multi-line value, since it escapes
 * newlines — sails through the line-count check untouched and lands whole in
 * the journal and the model's context.
 */
function clamp(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n… ${s.length - maxChars} more characters elided …`;
}
