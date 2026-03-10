/**
 * Stdio transport for MCP servers.
 *
 * Spawns a child process and communicates via newline-delimited JSON-RPC
 * over stdin/stdout (the standard MCP stdio transport).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { JsonRpcRequest, JsonRpcNotification, JsonRpcResponse } from './types.js';

export class StdioTransport extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = '';

  constructor(
    private command: string,
    private args: string[] = [],
    private env?: Record<string, string>,
  ) {
    super();
  }

  async start(): Promise<void> {
    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
    });

    this.process.stdout!.on('data', (data: Buffer) => {
      this.buffer += data.toString('utf-8');
      this.processBuffer();
    });

    // MCP servers may log to stderr — ignore silently
    this.process.stderr!.on('data', () => {});

    this.process.on('error', (err) => {
      this.emit('error', err);
    });

    this.process.on('close', (code) => {
      this.emit('close', code);
    });

    // Wait briefly for the process to start (or fail immediately)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 200);
      this.process!.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  send(message: JsonRpcRequest | JsonRpcNotification): void {
    if (!this.process?.stdin?.writable) {
      throw new Error('MCP transport not connected');
    }
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }

  async close(): Promise<void> {
    if (!this.process) return;

    this.process.stdin?.end();
    this.process.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.process?.kill('SIGKILL');
        resolve();
      }, 3000);
      this.process!.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.process = null;
  }

  private processBuffer(): void {
    // Newline-delimited JSON (NDJSON)
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        this.emit('message', msg);
      } catch {
        // Skip malformed lines
      }
    }
  }
}
