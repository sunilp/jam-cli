/**
 * Full tool set for `jam run` — read-only tools plus write tools.
 *
 * Uses the shared READ_ONLY_TOOL_SCHEMAS from context-tools.ts and adds
 * write tools (git_status, git_diff, write_file, apply_patch).
 */

import type { ToolDefinition } from '../providers/base.js';
import { READ_ONLY_TOOL_SCHEMAS, executeReadOnlyTool } from './context-tools.js';
import { JamError } from '../utils/errors.js';

// ── Write-capable tool schemas ────────────────────────────────────────────────

const WRITE_TOOL_SCHEMAS: ToolDefinition[] = [
  {
    name: 'git_status',
    description: 'Get current git status. Use this to see which files have been modified, staged, or are untracked.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'git_diff',
    description: 'Get git diff for the current changes. Use staged=true to see staged changes.',
    parameters: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Show staged changes instead of unstaged' },
        path: { type: 'string', description: 'Limit diff to a specific file path' },
      },
      required: [],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Use mode="append" to add to the end of a file. Default is "overwrite". Explain what you are changing and why before calling this tool.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        content: { type: 'string', description: 'The full content to write to the file' },
        mode: { type: 'string', description: '"overwrite" (default) or "append"' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'apply_patch',
    description: 'Apply a unified diff patch to modify files. Use this for precise, targeted edits to existing files.',
    parameters: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: 'Unified diff content (the patch to apply)' },
      },
      required: ['patch'],
    },
  },
  {
    name: 'run_command',
    description:
      'Execute a shell command and return its stdout and stderr. ' +
      'Use for running tests, builds, linters, or other safe commands. ' +
      'Dangerous commands (rm -rf, sudo, etc.) are blocked.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The executable to run (e.g. "npm", "git", "python")' },
        args: { type: 'string', description: 'Space-separated arguments (e.g. "test --run")' },
        timeout: { type: 'number', description: 'Timeout in seconds. Default is 30.' },
      },
      required: ['command'],
    },
  },
];

/** All tool schemas for the run command (read + write). */
export const ALL_TOOL_SCHEMAS: ToolDefinition[] = [
  ...READ_ONLY_TOOL_SCHEMAS,
  ...WRITE_TOOL_SCHEMAS,
];

/** Set of read-only tool names (no confirmation needed). */
export const READONLY_TOOL_NAMES = new Set(READ_ONLY_TOOL_SCHEMAS.map(t => t.name));

/**
 * Execute any tool (read or write).
 * For read-only tools, delegates to executeReadOnlyTool.
 * For write tools, uses the full registry.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
): Promise<string> {
  // Read-only tools share the same executor
  if (READONLY_TOOL_NAMES.has(name)) {
    return executeReadOnlyTool(name, args, workspaceRoot);
  }

  // Write tools use the full registry
  const { createDefaultRegistry } = await import('./registry.js');
  const registry = createDefaultRegistry();
  const tool = registry.get(name);
  if (!tool) {
    throw new JamError(`Unknown tool: ${name}`, 'TOOL_NOT_FOUND');
  }
  const result = await tool.execute(args, { workspaceRoot, cwd: process.cwd() });
  return result.error ? `Error: ${result.error}` : result.output;
}
