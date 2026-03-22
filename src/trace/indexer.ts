// src/trace/indexer.ts
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { TraceStore } from './store.js';
import { parseSource, detectLanguage, isTreeSitterAvailable } from './parser.js';
import { getExtractor } from './extractors/base.js';

// Register all extractors on import — triggers self-registration via registerExtractor()
import './extractors/typescript.js';
import './extractors/python.js';
import './extractors/sql.js';
import './extractors/java.js';

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', '.git', '.jam', 'coverage',
  '__pycache__', '.next', '.nuxt', 'target', 'out', '.venv', 'venv',
]);

export interface BuildIndexOptions {
  /** When true, re-parse all files regardless of mtime. */
  forceReindex?: boolean;
}

export async function buildIndex(
  workspaceRoot: string,
  indexDir: string,
  options?: BuildIndexOptions,
): Promise<TraceStore> {
  const store = new TraceStore(indexDir);

  if (!isTreeSitterAvailable()) {
    return store; // Return empty store — caller should fall back to regex engine
  }

  const files = await collectFiles(workspaceRoot);
  const forceReindex = options?.forceReindex ?? false;

  // Wrap all inserts in a transaction for performance (100x faster for 10k+ files)
  store.beginTransaction();

  for (const filePath of files) {
    const relPath = relative(workspaceRoot, filePath);
    const language = detectLanguage(filePath);
    if (!language) continue;

    const extractor = getExtractor(language);
    if (!extractor) continue;

    // Check mtime for incremental update
    const fileStat = await stat(filePath);
    const mtimeMs = fileStat.mtimeMs;

    if (!forceReindex) {
      const storedMtime = store.getFileMtime(relPath);
      if (storedMtime !== null && storedMtime >= mtimeMs) continue; // Skip unchanged
    }

    // Clear old records for this file
    store.clearFile(relPath);

    // Parse with tree-sitter
    const source = await readFile(filePath, 'utf-8');
    const tree = await parseSource(source, language);
    if (!tree) continue;

    // Run the language extractor
    const result = extractor.extract(tree.rootNode, source);

    // Write symbols — build a name→id map for resolving calls and column refs
    const symbolIdMap = new Map<string, number>();
    for (const sym of result.symbols) {
      const id = store.insertSymbol({ ...sym, file: relPath, language });
      symbolIdMap.set(sym.name, id);
    }

    // Write calls (resolve caller name → id)
    for (const call of result.calls) {
      const callerId = symbolIdMap.get(call.callerName);
      if (callerId !== undefined) {
        store.insertCall({
          callerId,
          calleeName: call.calleeName,
          file: relPath,
          line: call.line,
          arguments: call.arguments,
          kind: call.kind,
        });
      }
    }

    // Write imports
    for (const imp of result.imports) {
      store.insertImport({ ...imp, file: relPath });
    }

    // Write column refs (resolve symbol name → id)
    for (const col of result.columns) {
      const symbolId = symbolIdMap.get(col.symbolName);
      if (symbolId !== undefined) {
        store.insertColumn({
          symbolId,
          tableName: col.tableName,
          columnName: col.columnName,
          operation: col.operation,
        });
      }
    }

    // Record the file mtime so subsequent runs can skip it
    store.upsertFile(relPath, mtimeMs, language);
  }

  store.commitTransaction();

  return store;
}

async function collectFiles(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return; // Skip unreadable directories
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          await walk(join(d, entry.name));
        }
      } else if (entry.isFile() && detectLanguage(entry.name)) {
        results.push(join(d, entry.name));
      }
    }
  }

  await walk(dir);
  return results;
}
