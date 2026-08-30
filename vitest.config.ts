import { defineConfig, configDefaults } from 'vitest/config';

// node:sqlite is only available unflagged from Node 22.13 onward (see
// assertNodeSupported in src/commands/agent.ts): Node 20 doesn't have the
// module at all, and Node 22.5-22.12 has it gated behind
// --experimental-sqlite. Every file under src/harness/** and
// src/commands/agent.test.ts constructs a Journal or ArtifactStore — both of
// which call node:sqlite's loader (src/harness/sqlite.ts) from their
// constructor — so on an unsupported Node version those suites fail at
// runtime, not just at import. They are excluded wholesale here rather than
// hand-listed file by file, because a hand-list silently stops covering a
// new file the next time someone adds one that imports artifacts.js or
// journal.js — an exclude by directory can't rot that way.
const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split('.').map(Number);
const sqliteUnavailable = nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13);

if (sqliteUnavailable) {
  // Loud and impossible to miss in CI logs: a green run on this Node version
  // does NOT mean the harness/agent code was exercised.
  console.warn(
    '\n'.repeat(2) +
    '='.repeat(72) + '\n' +
    `SKIPPING src/harness/** and src/commands/agent.test.ts\n` +
    `node:sqlite is unavailable unflagged on Node ${process.versions.node} ` +
    `(requires 22.13+).\n` +
    `This run does NOT cover the jam agent harness. See src/harness/sqlite.ts.\n` +
    '='.repeat(72) +
    '\n'.repeat(2)
  );
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: sqliteUnavailable
      ? [...configDefaults.exclude, 'src/harness/**', 'src/commands/agent.test.ts']
      : configDefaults.exclude,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
    globals: true,
  },
});
