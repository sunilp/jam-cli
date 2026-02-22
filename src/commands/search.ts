import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { withRetry, collectStream } from '../utils/stream.js';
import { streamToStdout, printJsonResult, printError } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import type { CliOverrides } from '../config/schema.js';

const execFileAsync = promisify(execFile);

export interface SearchOptions extends CliOverrides {
  glob?: string;
  maxResults?: number;
  ask?: boolean;   // pipe results to AI for explanation
  json?: boolean;
}

async function searchWithRipgrep(
  query: string,
  cwd: string,
  glob?: string,
  maxResults = 20
): Promise<string> {
  const args = [
    '--line-number',
    '--color=never',
    '--max-count=1',
    `--max-filesize=500K`,
    '-m', String(maxResults),
  ];
  if (glob) args.push('--glob', glob);
  args.push('--', query, '.');

  const { stdout } = await execFileAsync('rg', args, { cwd, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
}

async function searchFallback(
  query: string,
  cwd: string,
  glob?: string,
  maxResults = 20
): Promise<string> {
  const results: string[] = [];
  const queryLower = query.toLowerCase();

  async function walk(dir: string): Promise<void> {
    if (results.length >= maxResults) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git', 'dist', '.cache'].includes(entry.name)) continue;
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (glob) {
          const { minimatch } = await import('minimatch').catch(() => ({ minimatch: null }));
          if (minimatch && !minimatch(entry.name, glob)) continue;
        }
        try {
          const s = await stat(fullPath);
          if (s.size > 500_000) continue;
          const content = await readFile(fullPath, 'utf-8');
          const lines = content.split('\n');
          lines.forEach((line, i) => {
            if (results.length >= maxResults) return;
            if (line.toLowerCase().includes(queryLower)) {
              const rel = relative(cwd, fullPath);
              results.push(`${rel}:${i + 1}: ${line.trim()}`);
            }
          });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  await walk(cwd);
  return results.join('\n');
}

export async function runSearch(query: string | undefined, options: SearchOptions): Promise<void> {
  if (!query) {
    await printError('Provide a search query. Usage: jam search "<query>"');
    process.exit(1);
  }

  try {
    const workspaceRoot = await getWorkspaceRoot();
    const maxResults = options.maxResults ?? 20;

    let results: string;
    try {
      results = await searchWithRipgrep(query, workspaceRoot, options.glob, maxResults);
    } catch {
      // rg not available or failed — use JS fallback
      results = await searchFallback(query, workspaceRoot, options.glob, maxResults);
    }

    if (!results) {
      process.stdout.write(`No results found for: ${query}\n`);
      return;
    }

    if (!options.ask) {
      process.stdout.write(results + '\n');
      return;
    }

    // Pipe results to AI
    const config = await loadConfig(process.cwd(), options);
    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    const prompt =
      `I searched the codebase for "${query}" and found these results:\n\n` +
      `\`\`\`\n${results}\n\`\`\`\n\n` +
      `Please explain what these results tell us about the codebase and the query topic.`;

    const request = {
      messages: [{ role: 'user' as const, content: prompt }],
      model: profile.model,
      systemPrompt: profile.systemPrompt,
    };

    if (options.json) {
      const { text, usage } = await collectStream(
        withRetry(() => adapter.streamCompletion(request))
      );
      printJsonResult({ response: text, usage, model: profile.model });
    } else {
      await streamToStdout(withRetry(() => adapter.streamCompletion(request)));
    }
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message);
    process.exit(1);
  }
}
