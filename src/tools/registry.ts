import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { JamError } from '../utils/errors.js';
import type { ToolPolicy } from '../config/schema.js';
import type { ToolDefinition, ToolContext, ToolResult } from './types.js';
import { readFileTool } from './read_file.js';
import { listDirTool } from './list_dir.js';
import { searchTextTool } from './search_text.js';
import { gitDiffTool } from './git_diff.js';
import { gitStatusTool } from './git_status.js';
import { applyPatchTool } from './apply_patch.js';
import { writeFileTool } from './write_file.js';
import { runCommandTool } from './run_command.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
    policy: ToolPolicy
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new JamError(`Tool not found: "${name}"`, 'TOOL_NOT_FOUND');
    }

    if (!tool.readonly) {
      // Write tool — enforce policy
      if (policy === 'never') {
        throw new JamError(
          `Tool execution denied by policy: "${name}" is a write tool and policy is "never".`,
          'TOOL_DENIED'
        );
      }

      if (policy === 'ask_every_time') {
        const confirmed = await this.confirmExecution(tool, args);
        if (!confirmed) {
          throw new JamError(
            `Tool execution denied by user: "${name}"`,
            'TOOL_DENIED'
          );
        }
      }
      // policy === 'allowlist' falls through to execution below
    }

    try {
      return await tool.execute(args, ctx);
    } catch (err: unknown) {
      if (JamError.isJamError(err)) throw err;
      throw new JamError(
        `Tool "${name}" threw an unexpected error.`,
        'TOOL_EXEC_ERROR',
        { cause: err }
      );
    }
  }

  private async confirmExecution(
    tool: ToolDefinition,
    args: Record<string, unknown>
  ): Promise<boolean> {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const argsJson = JSON.stringify(args, null, 2);
      const prompt =
        `\nTool: ${tool.name}\n` +
        `Description: ${tool.description}\n` +
        `Args:\n${argsJson}\n` +
        `\nThis is a write operation. Proceed? [y/N] `;

      const answer = await rl.question(prompt);
      return answer.trim().toLowerCase() === 'y';
    } finally {
      rl.close();
    }
  }
}

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(listDirTool);
  registry.register(searchTextTool);
  registry.register(gitDiffTool);
  registry.register(gitStatusTool);
  registry.register(applyPatchTool);
  registry.register(writeFileTool);
  registry.register(runCommandTool);
  return registry;
}
