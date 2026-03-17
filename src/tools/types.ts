import { resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { JamError } from '../utils/errors.js';

export interface ToolContext {
  workspaceRoot: string;
  cwd: string;
}

/**
 * Resolve a path relative to the workspace root and verify it stays inside.
 * Prevents path traversal attacks (../../etc/passwd) and symlink escapes.
 * Throws TOOL_DENIED if the resolved path is outside the workspace.
 */
export async function safePath(workspaceRoot: string, relativePath: string): Promise<string> {
  const resolved = resolve(workspaceRoot, relativePath);
  const normalizedRoot = resolve(workspaceRoot);

  // Check the resolved path first (catches obvious ../../../ traversal)
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + sep)) {
    throw new JamError(
      `Path "${relativePath}" resolves outside the workspace. Access denied.`,
      'TOOL_DENIED',
      { retryable: false }
    );
  }

  // Also check the real path to catch symlink escapes (only if the target exists)
  try {
    const real = await realpath(resolved);
    const realRoot = await realpath(normalizedRoot);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new JamError(
        `Path "${relativePath}" is a symlink pointing outside the workspace. Access denied.`,
        'TOOL_DENIED',
        { retryable: false }
      );
    }
  } catch (err) {
    // ENOENT is fine — file doesn't exist yet (e.g., write_file creating new file)
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && err instanceof JamError) {
      throw err;
    }
  }

  return resolved;
}

export interface ToolResult {
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  readonly: boolean;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; optional?: boolean }>;
    required: string[];
  };
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
