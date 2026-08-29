import { resolve, sep } from 'node:path';
import type { z } from 'zod';
import type { ExecutionWorld } from '../world/types.js';
import type { ArtifactStore, ArtifactRef } from '../artifacts.js';
import type { RiskLevel, RuntimeEvent } from '../events.js';

export type StructuredErrorType =
  | 'patch.conflict' | 'shell.timeout' | 'file.changed_externally'
  | 'sandbox.denied' | 'not_found' | 'invalid_input' | 'internal';

export interface StructuredError {
  type: StructuredErrorType;
  recoverable: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export type ToolResult<O> =
  | { ok: true; value: O; artifact?: ArtifactRef }
  | { ok: false; error: StructuredError };

export interface ToolContext {
  world: ExecutionWorld;
  workspaceRoot: string;
  signal: AbortSignal;
  emit(e: RuntimeEvent): void;
  artifacts: ArtifactStore;
  callId: string;
}

export interface Tool<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType<I>;
  /** A function for run_command, whose risk depends on the command itself. */
  readonly risk: RiskLevel | ((input: I) => RiskLevel);
  /**
   * True if this tool can change the workspace. The loop checkpoints before a
   * batch containing any such tool. run_command is true conservatively: an
   * arbitrary command can write files.
   */
  readonly mutates: boolean;
  execute(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

export interface Disposable { dispose(): void }

export function riskOf<I>(tool: Tool<I, unknown>, input: I): RiskLevel {
  return typeof tool.risk === 'function' ? tool.risk(input) : tool.risk;
}

/**
 * Pipeline step 2, canonicalization. Resolves relative to the workspace root
 * and refuses to leave it, including via symlink. Adapted from the archived
 * src/tools/types.ts, which threw JamError; this throws a plain Error that
 * dispatch converts into a sandbox.denied ToolResult.
 */
export async function safePath(
  world: ExecutionWorld,
  workspaceRoot: string,
  relativePath: string
): Promise<string> {
  const root = resolve(workspaceRoot);
  const resolved = resolve(root, relativePath);

  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Path "${relativePath}" resolves outside the workspace. Access denied.`);
  }

  try {
    const real = await world.fs.realpath(resolved);
    const realRoot = await world.fs.realpath(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      throw new Error(`Path "${relativePath}" resolves outside the workspace. Access denied.`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('outside the workspace')) throw err;
    // A path that does not exist yet is fine — tools create files. Anything
    // else (ELOOP, EACCES, invalid argument) is a refusal, not a pass: a
    // boundary guard that fails open is not a boundary guard.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new Error(
        `Path "${relativePath}" could not be resolved (${code ?? 'unknown'}). Access denied.`
      );
    }
  }

  return resolved;
}
