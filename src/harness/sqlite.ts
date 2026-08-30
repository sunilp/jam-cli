import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

/**
 * The one place the SQLite driver is obtained.
 *
 * A static `import { DatabaseSync } from 'node:sqlite'` breaks under the
 * installed vitest 1.6.1: vite-node strips the `node:` prefix from every
 * builtin except `node:test`, then fails to resolve bare `sqlite`. Loading
 * through createRequire bypasses that transform and behaves identically at
 * runtime. Remove this indirection once vitest is upgraded.
 *
 * better-sqlite3 is deliberately not used: its native binding is compiled per
 * Node ABI and cannot be rebuilt offline here.
 *
 * Loading is deferred to first call, not done at module-evaluation time. On
 * Node 20 (and on Node 22.5–22.12, where node:sqlite exists but is gated
 * behind --experimental-sqlite) `require('node:sqlite')` throws
 * ERR_UNKNOWN_BUILTIN_MODULE. A static require at the top of this module
 * would crash every file that imports Journal or ArtifactStore purely by
 * importing them — including at test-collection time, before
 * assertNodeSupported (src/commands/agent.ts) ever gets a chance to run and
 * produce an actionable error. Callers must invoke loadSqlite() inside their
 * constructor, not at their own module scope, or the crash just moves one
 * file over.
 */
const nodeRequire = createRequire(import.meta.url);

interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseSyncType;
}

let cached: SqliteModule | undefined;

export function loadSqlite(): SqliteModule {
  cached ??= nodeRequire('node:sqlite') as SqliteModule;
  return cached;
}

export type { DatabaseSyncType };
