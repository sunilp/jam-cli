import { spawn } from 'node:child_process';

/**
 * Spawns a child process and returns stdout as a string.
 * Rejects with an Error containing stderr if the process exits with a non-zero code.
 */
export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000
): Promise<string> {
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
        resolve(stdout);
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
