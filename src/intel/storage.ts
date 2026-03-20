// src/intel/storage.ts

import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { IntelGraph } from './graph.js';
import type { SerializedGraph, SerializedEnrichment, SemanticMetadata, EnrichDepth } from './types.js';

function storageDir(rootDir: string): string {
  return join(rootDir, '.jam', 'intel');
}

async function ensureStorageDir(rootDir: string): Promise<string> {
  const dir = storageDir(rootDir);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Save an IntelGraph to disk as graph.json.
 * Uses a lock file to prevent concurrent writes.
 */
export async function saveGraph(graph: IntelGraph, rootDir: string): Promise<void> {
  const dir = await ensureStorageDir(rootDir);
  const lockPath = join(dir, '.lock');

  // Acquire lock
  let lockAcquired = false;
  try {
    await writeFile(lockPath, process.pid.toString(), { flag: 'wx' });
    lockAcquired = true;

    const serialized = graph.serialize(rootDir);
    await writeFile(join(dir, 'graph.json'), JSON.stringify(serialized, null, 2), 'utf-8');
  } finally {
    if (lockAcquired) {
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

/**
 * Load an IntelGraph from disk. Returns null if no graph file exists.
 */
export async function loadGraph(rootDir: string): Promise<IntelGraph | null> {
  const graphPath = join(storageDir(rootDir), 'graph.json');
  let content: string;
  try {
    content = await readFile(graphPath, 'utf-8');
  } catch {
    return null;
  }

  try {
    const data = JSON.parse(content) as SerializedGraph;
    return IntelGraph.deserialize(data);
  } catch {
    return null;
  }
}

/**
 * Save enrichment results to disk.
 */
export async function saveEnrichment(
  entries: SemanticMetadata[],
  meta: { depth: EnrichDepth; tokensUsed: number },
  rootDir: string,
): Promise<void> {
  const dir = await ensureStorageDir(rootDir);
  const enrichment: SerializedEnrichment = {
    version: 1,
    enrichedAt: new Date().toISOString(),
    depth: meta.depth,
    tokensUsed: meta.tokensUsed,
    entries,
  };
  await writeFile(join(dir, 'enrichment.json'), JSON.stringify(enrichment, null, 2), 'utf-8');
}

/**
 * Load enrichment data from disk. Returns null if no enrichment file exists.
 */
export async function loadEnrichment(rootDir: string): Promise<SerializedEnrichment | null> {
  const enrichPath = join(storageDir(rootDir), 'enrichment.json');
  let content: string;
  try {
    content = await readFile(enrichPath, 'utf-8');
  } catch {
    return null;
  }

  try {
    return JSON.parse(content) as SerializedEnrichment;
  } catch {
    return null;
  }
}

/**
 * Save a Mermaid diagram to disk.
 * Returns the full path of the written file.
 */
export async function saveMermaid(
  mermaid: string,
  rootDir: string,
  filename = 'architecture.mmd',
): Promise<string> {
  const dir = await ensureStorageDir(rootDir);
  const filePath = join(dir, filename);
  await writeFile(filePath, mermaid, 'utf-8');
  return filePath;
}

/**
 * Check if the .jam or .jam/intel directory is listed in the project's .gitignore.
 */
export function checkGitignore(rootDir: string): boolean {
  // Synchronous read — intentional to keep the API simple for a quick status check
  let content: string;
  try {
    content = readFileSync(join(rootDir, '.gitignore'), 'utf-8');
  } catch {
    return false;
  }

  return content.includes('.jam/intel') || content.includes('.jam');
}
