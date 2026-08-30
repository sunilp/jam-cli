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
 */
const nodeRequire = createRequire(import.meta.url);

const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType;
};

export { DatabaseSync };
export type { DatabaseSyncType };
