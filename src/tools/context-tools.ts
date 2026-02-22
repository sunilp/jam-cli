/**
 * Read-only tools shared between `jam ask` and `jam chat`.
 *
 * `READ_ONLY_TOOL_SCHEMAS` is the provider-facing schema (sent to the LLM).
 * `executeReadOnlyTool` dispatches to the in-process tool registry.
 */

import type { ToolDefinition as ProviderToolDefinition } from '../providers/base.js';
import { JamError } from '../utils/errors.js';

// ── Provider-facing schemas ───────────────────────────────────────────────────

export const READ_ONLY_TOOL_SCHEMAS: ProviderToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a source file. Use this to examine code after finding relevant files via search_text or list_dir.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root, e.g. "src/providers/ollama.ts"' },
        start_line: { type: 'number', description: 'First line to read (1-based). Omit to read from the beginning.' },
        end_line: { type: 'number', description: 'Last line to read (inclusive). Omit to read to the end.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and sub-directories at a path. Use this to explore the project structure and find relevant source files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to workspace root. Use "src/commands" or "src/providers" etc. Defaults to "."' },
      },
      required: [],
    },
  },
  {
    name: 'search_text',
    description: 'Search for a text pattern across source files. IMPORTANT: Search for specific code identifiers like function names, class names, import paths, or variable names — NOT vague English words. The query parameter must be a non-empty string.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A specific code identifier to search for, e.g. "streamCompletion", "createProvider", "fetch(". Must be non-empty.' },
        glob: { type: 'string', description: 'File glob pattern, e.g. "*.ts" for TypeScript files. Recommended: always set this for TypeScript projects.' },
        max_results: { type: 'number', description: 'Maximum number of results. Default: 20.' },
      },
      required: ['query'],
    },
  },
];

// ── Executor ──────────────────────────────────────────────────────────────────

/**
 * Execute a read-only tool by name and return its text output.
 * Throws for unknown tools or execution errors.
 */
export async function executeReadOnlyTool(
  name: string,
  args: Record<string, unknown>,
  workspaceRoot: string
): Promise<string> {
  const { createDefaultRegistry } = await import('./registry.js');
  const registry = createDefaultRegistry();
  const tool = registry.get(name);
  if (!tool) {
    throw new JamError(`Unknown tool: ${name}`, 'TOOL_NOT_FOUND');
  }
  const result = await tool.execute(args, { workspaceRoot, cwd: process.cwd() });
  return result.error ? `Error: ${result.error}` : result.output;
}
