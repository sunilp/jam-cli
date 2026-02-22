import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { JamError } from '../utils/errors.js';
import type { ToolDefinition, ToolContext, ToolResult } from './types.js';

const SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 20;

function runRipgrep(
  query: string,
  cwd: string,
  glob: string | undefined,
  maxResults: number
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const args = [
      '--line-number',
      '--no-heading',
      '--color=never',
      `--max-count=${maxResults}`,
    ];

    if (glob !== undefined) {
      args.push('--glob', glob);
    }

    args.push(query, '.');

    const child = spawn('rg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('ripgrep timed out'));
    }, SEARCH_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || code === 1) {
        // code 1 = no matches, which is fine
        resolve(stdout.trim() === '' ? [] : stdout.trim().split('\n'));
      } else {
        reject(new Error(`rg exited with code ${code}: ${stderr}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function collectFiles(dir: string, globPattern: string | undefined): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = String(entry.name);
      // Skip hidden directories (like .git) and node_modules
      if (name.startsWith('.') || name === 'node_modules') {
        continue;
      }

      const fullPath = join(current, name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (globPattern !== undefined) {
          // Simple glob: support *.ext and **/*.ext patterns
          const dotIdx = globPattern.lastIndexOf('.');
          if (dotIdx !== -1) {
            const ext = globPattern.slice(dotIdx);
            if (!name.endsWith(ext)) {
              continue;
            }
          }
        }
        results.push(fullPath);
      }
    }
  }

  await walk(dir);
  return results;
}

async function nodeFallbackSearch(
  query: string,
  workspaceRoot: string,
  glob: string | undefined,
  maxResults: number
): Promise<string[]> {
  const files = await collectFiles(workspaceRoot, glob);
  const matchLines: string[] = [];
  const lowerQuery = query.toLowerCase();

  outer: for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.toLowerCase().includes(lowerQuery)) {
        const relPath = relative(workspaceRoot, file);
        matchLines.push(`${relPath}:${i + 1}: ${line}`);
        if (matchLines.length >= maxResults) {
          break outer;
        }
      }
    }
  }

  return matchLines;
}

export const searchTextTool: ToolDefinition = {
  name: 'search_text',
  description:
    'Search for text across files in the workspace. Uses ripgrep if available, otherwise falls back to a Node.js implementation.',
  readonly: true,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The text or regex pattern to search for.' },
      glob: {
        type: 'string',
        description: 'Optional glob pattern to restrict the search (e.g. "**/*.ts").',
        optional: true,
      },
      maxResults: {
        type: 'number',
        description: `Maximum number of results to return. Defaults to ${DEFAULT_MAX_RESULTS}.`,
        optional: true,
      },
    },
    required: ['query'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = args['query'];
    if (typeof query !== 'string' || query.trim() === '') {
      throw new JamError('Argument "query" must be a non-empty string.', 'INPUT_MISSING');
    }

    const glob = typeof args['glob'] === 'string' ? args['glob'] : undefined;
    const maxResults =
      typeof args['maxResults'] === 'number' && args['maxResults'] > 0
        ? args['maxResults']
        : DEFAULT_MAX_RESULTS;

    const absoluteRoot = resolve(ctx.workspaceRoot);

    let matchLines: string[];
    let usedFallback = false;

    try {
      matchLines = await runRipgrep(query, absoluteRoot, glob, maxResults);
    } catch {
      // rg not available or failed — fall back to Node.js search
      usedFallback = true;
      try {
        matchLines = await nodeFallbackSearch(query, absoluteRoot, glob, maxResults);
      } catch (err) {
        throw new JamError('Search failed.', 'TOOL_EXEC_ERROR', { cause: err });
      }
    }

    if (matchLines.length === 0) {
      return {
        output: 'No matches found.',
        metadata: { query, usedFallback, matchCount: 0 },
      };
    }

    const output = matchLines.join('\n');

    return {
      output,
      metadata: { query, usedFallback, matchCount: matchLines.length },
    };
  },
};
