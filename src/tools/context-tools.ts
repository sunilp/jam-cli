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
    description: 'Read the contents of a file in the workspace',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        start_line: { type: 'number', description: 'First line to read (1-based, optional)' },
        end_line: { type: 'number', description: 'Last line to read (inclusive, optional)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and sub-directories at a path in the workspace',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to workspace root (default: ".")' },
      },
      required: [],
    },
  },
  {
    name: 'search_text',
    description: 'Search for text patterns in the codebase using ripgrep',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (regex supported)' },
        glob: { type: 'string', description: 'File glob to restrict search (e.g. "*.ts")' },
        max_results: { type: 'number', description: 'Maximum number of results (default 20)' },
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
