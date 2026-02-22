import { spawn } from 'node:child_process';
import { JamError } from '../utils/errors.js';
import type { ToolDefinition, ToolContext, ToolResult } from './types.js';

// Patterns that are never allowed regardless of policy
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f\b/,   // rm -rf, rm -fr, etc.
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r\b/,
  /\bsudo\b/,
  /\bsu\s+-/,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  />\s*\/dev\/(s|h|v)d[a-z]/,           // overwriting block devices
  /\bchmod\s+777\s+\//,
  /\bshutdown\b/,
  /\breboot\b/,
];

/**
 * Spawns a child process and returns { stdout, stderr } as strings.
 * Rejects with an Error if the process exits with a non-zero code or times out.
 */
export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

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
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = stderr.trim() || stdout.trim();
        reject(
          new Error(
            `Command "${command} ${args.join(' ')}" exited with code ${code}${detail ? `: ${detail}` : ''}`
          )
        );
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Check a full command string against dangerous patterns. */
function isDangerous(fullCommand: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(fullCommand));
}

export const runCommandTool: ToolDefinition = {
  name: 'run_command',
  description:
    'Execute a shell command and return its stdout and stderr. ' +
    'Use for running tests, builds, linters, or other safe commands. ' +
    'Dangerous commands (rm -rf, sudo, etc.) are blocked. ' +
    'Note: arguments are split on whitespace; quoted arguments with spaces are not supported.',
  readonly: false,
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The executable or shell command to run (e.g. "npm", "git", "python").',
      },
      args: {
        type: 'string',
        description: 'Space-separated arguments to pass to the command (e.g. "test --run").',
        optional: true,
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds. Default is 30.',
        optional: true,
      },
    },
    required: ['command'],
  },

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const command = args['command'];
    if (typeof command !== 'string' || command.trim() === '') {
      throw new JamError('Argument "command" must be a non-empty string.', 'INPUT_MISSING');
    }

    const rawArgs = args['args'];
    const cmdArgs: string[] =
      typeof rawArgs === 'string' && rawArgs.trim() !== ''
        ? rawArgs.trim().split(/\s+/)
        : [];

    const timeoutArg = args['timeout'];
    const timeoutMs =
      typeof timeoutArg === 'number' && timeoutArg > 0 ? timeoutArg * 1000 : 30_000;

    const fullCommand = [command, ...cmdArgs].join(' ');

    if (isDangerous(fullCommand)) {
      throw new JamError(
        `Command rejected: "${fullCommand}" matches a dangerous pattern and cannot be executed.`,
        'TOOL_DENIED'
      );
    }

    let result: { stdout: string; stderr: string };
    try {
      result = await runCommand(command.trim(), cmdArgs, ctx.workspaceRoot, timeoutMs);
    } catch (err: unknown) {
      if (err instanceof Error) {
        return {
          output: err.message,
          error: err.message,
          metadata: { command: fullCommand, exitCode: 1 },
        };
      }
      throw new JamError(`run_command failed: ${String(err)}`, 'TOOL_EXEC_ERROR', { cause: err });
    }

    const output = [
      result.stdout.trim() ? result.stdout : '',
      result.stderr.trim() ? `[stderr]\n${result.stderr}` : '',
    ]
      .filter(Boolean)
      .join('\n')
      .trim();

    return {
      output: output || '(no output)',
      metadata: { command: fullCommand },
    };
  },
};
