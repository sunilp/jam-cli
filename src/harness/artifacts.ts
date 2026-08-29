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
  const budgetTotal = opts.maxChars ?? MAX_CHARS;
  const lines = content.split('\n');
  // Return untouched ONLY if it fits on both axes. Few-but-long lines used to
  // take this path and get a blind end-cut, losing the tail and any error text
  // with only a generic notice — reachable in production through run_command
  // and git_diff, which preview real multi-line output.
  if (lines.length <= head + tail && content.length <= budgetTotal) return content;

  // When line count alone doesn't overflow, there is no head/tail split to
  // make: everything is "head" (bounded below by its own character budget),
  // and there is no middle to search for error lines.
  const overflowsByLines = lines.length > head + tail;
  const headLines = overflowsByLines ? lines.slice(0, head) : lines;
  const tailLines = overflowsByLines ? lines.slice(-tail) : [];
  const middle = overflowsByLines ? lines.slice(head, lines.length - tail) : [];
  const allErrors = middle.filter((l) => ERROR_LINE.test(l));
  const errors = allErrors.slice(0, MAX_ERROR_LINES);
  const dropped = allErrors.length - errors.length;

  // Budget each section separately. A blind clamp of the joined string cuts
  // from the END, which silently eats the tail and even the error block when
  // lines are long — exactly the "dropped without saying so" failure the error
  // notice exists to prevent. Sectioned budgets keep the structure intact.
  const budget = budgetTotal;
  const parts = [
    ...clampSection(headLines, Math.floor(budget * (overflowsByLines ? 0.4 : 0.7))),
    ...(middle.length ? [`… ${middle.length} lines elided …`] : []),
    ...(errors.length
      ? [
          '--- error lines ---',
          ...clampSection(errors, Math.floor(budget * 0.3)),
          // Never drop error lines without saying so: a model debugging a
          // failure it caused must know its stack trace was truncated.
          ...(dropped > 0 ? [`… ${dropped} more error lines omitted …`] : []),
        ]
      : []),
    // clampSection keeps whatever fits from the FRONT of what it's given and
    // elides the rest — correct for head (keep the earliest lines) and for
    // errors (already front-truncated to MAX_ERROR_LINES above), but backwards
    // for tail: without reversing, it would keep tailLines' earliest entries
    // and silently drop the actual last lines of the output — the exact
    // "cuts from the end" failure this whole budgeting scheme exists to avoid,
    // just relocated one level down. Reverse in, clamp, reverse back.
    ...(tailLines.length
      ? clampSection(tailLines.slice().reverse(), Math.floor(budget * 0.3)).reverse()
      : []),
  ];
  return clamp(parts.join('\n'), budget * 2);
}

/** Keep as many whole lines as fit, and say how many were left out. */
function clampSection(lines: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (used + line.length + 1 > budget) {
      const room = budget - used;
      // A single line longer than the whole budget must still contribute its
      // beginning. Reporting "1 line elided" with no content is useless to a
      // model trying to read its own stack trace.
      let consumed = i;
      if (out.length === 0 && room > 120) {
        out.push(`${line.slice(0, room - 60)}… line truncated …`);
        consumed = i + 1;
      }
      if (consumed < lines.length) {
        out.push(`… ${lines.length - consumed} more lines elided …`);
      }
      return out;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out;
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
