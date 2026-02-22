import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JamError } from '../utils/errors.js';
import type { ToolDefinition, ToolContext, ToolResult } from './types.js';
import { runCommand } from './run_command.js';

export const applyPatchTool: ToolDefinition = {
  name: 'apply_patch',
  description:
    'Apply a unified diff patch to the workspace using git apply. ' +
    'The patch is validated before being applied.',
  readonly: false,
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description: 'The unified diff content to apply.',
      },
    },
    required: ['patch'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const patch = args['patch'];
    if (typeof patch !== 'string' || patch.trim() === '') {
      throw new JamError('Argument "patch" must be a non-empty string.', 'INPUT_MISSING');
    }

    // Write patch to a temp file
    let tempDir: string;
    let tempFile: string;
    try {
      tempDir = await mkdtemp(join(tmpdir(), 'jam-patch-'));
      tempFile = join(tempDir, 'patch.diff');
      await writeFile(tempFile, patch, 'utf8');
    } catch (err) {
      throw new JamError('Failed to write temporary patch file.', 'TOOL_EXEC_ERROR', {
        cause: err,
      });
    }

    try {
      // Validate the patch first
      try {
        await runCommand('git', ['apply', '--check', tempFile], ctx.workspaceRoot);
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new JamError(
          `Patch validation failed: ${detail}`,
          'PROVIDER_STREAM_ERROR',
          { cause: err }
        );
      }

      // Apply the patch
      let stdout: string;
      try {
        ({ stdout } = await runCommand('git', ['apply', tempFile], ctx.workspaceRoot));
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new JamError(
          `Patch application failed: ${detail}`,
          'PROVIDER_STREAM_ERROR',
          { cause: err }
        );
      }

      // Determine changed files
      let changedFilesOutput = stdout.trim();
      if (changedFilesOutput === '') {
        // Parse filenames from the patch header lines
        const changedFiles = [...patch.matchAll(/^(?:\+\+\+|---) (?:b\/|a\/)?(.+)$/gm)]
          .map((m) => m[1]?.trim())
          .filter((f): f is string => f !== undefined && f !== '/dev/null')
          .filter((f, i, arr) => arr.indexOf(f) === i);

        changedFilesOutput =
          changedFiles.length > 0
            ? `Changed files:\n${changedFiles.map((f) => `  ${f}`).join('\n')}`
            : 'Patch applied successfully.';
      }

      return {
        output: changedFilesOutput,
        metadata: { patchLength: patch.length },
      };
    } finally {
      // Clean up temp file regardless of outcome
      try {
        await unlink(tempFile);
      } catch {
        // Best-effort cleanup
      }
    }
  },
};
