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
  const budget = opts.maxChars ?? MAX_CHARS;
  const lines = content.split('\n');

  // Untouched only if it fits on BOTH axes.
  if (lines.length <= head + tail && content.length <= budget) return content;

  const overflowsByLines = lines.length > head + tail;
  const headLines = overflowsByLines ? lines.slice(0, head) : lines;
  const tailLines = overflowsByLines ? lines.slice(-tail) : [];
  const middle = overflowsByLines ? lines.slice(head, lines.length - tail) : [];

  const headPart = clampSection(headLines, Math.floor(budget * (overflowsByLines ? 0.4 : 0.7)));
  const tailPart = tailLines.length
    ? reversed(clampSection(tailLines.slice().reverse(), Math.floor(budget * 0.3)))
    : { kept: [], dropped: [] };

  // Scan everything that will NOT reach the model, whatever dropped it. Scanning
  // only the line-sliced middle meant error detection never ran at all when the
  // content fit by line count and overflowed only on characters — which is the
  // shape run_command, git_diff and dispatch's JSON-serialised values actually
  // produce. Error lines then survived by position, not by guarantee.
  const unseen = [...headPart.dropped, ...middle, ...tailPart.dropped];
  const allErrors = unseen.filter((l) => ERROR_LINE.test(l));
  const errors = allErrors.slice(0, MAX_ERROR_LINES);
  const omitted = allErrors.length - errors.length;

  const parts = [
    ...headPart.kept,
    ...(middle.length ? [`… ${middle.length} lines elided …`] : []),
    ...(errors.length
      ? [
          '--- error lines ---',
          ...clampSection(errors, Math.floor(budget * 0.3)).kept,
          // Never drop error lines without saying so: a model debugging a
          // failure it caused must know its stack trace was truncated.
          ...(omitted > 0 ? [`… ${omitted} more error lines omitted …`] : []),
        ]
      : []),
    ...tailPart.kept,
  ];
  return clamp(parts.join('\n'), budget * 2);
}

interface Section { kept: string[]; dropped: string[] }

function reversed(s: Section): Section {
  return { kept: s.kept.slice().reverse(), dropped: s.dropped };
}

/**
 * Keep as many whole lines as fit, say how many were left out, and report
 * exactly which lines were dropped so the caller can scan them for errors.
 */
function clampSection(lines: string[], budget: number): Section {
  const kept: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (used + line.length + 1 > budget) {
      const room = budget - used;
      // A single line longer than the whole budget must still contribute its
      // beginning. "1 line elided" with no content is useless to a model
      // trying to read its own stack trace.
      let consumed = i;
      // The REMAINDER of a truncated line is content the model will not see.
      // It must be reported as dropped, or error text sitting past the cutoff
      // vanishes from the error scan entirely — which is what happens to
      // dispatch's JSON-serialised tool output, always one giant line.
      let remainder: string[] = [];
      if (kept.length === 0 && room > 120) {
        kept.push(`${line.slice(0, room - 60)}… line truncated …`);
        remainder = [line.slice(room - 60)];
        consumed = i + 1;
      }
      if (consumed < lines.length) {
        kept.push(`… ${lines.length - consumed} more lines elided …`);
      }
      return { kept, dropped: [...remainder, ...lines.slice(consumed)] };
    }
    kept.push(line);
    used += line.length + 1;
  }
  return { kept, dropped: [] };
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
