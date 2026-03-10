/**
 * MCP client — connects to a single MCP server over stdio transport.
 *
 * Handles the JSON-RPC lifecycle: initialize → list tools → call tools → close.
 */

import { StdioTransport } from './transport.js';
import type {
  McpServerConfig,
  McpInitializeResult,
  McpToolSchema,
  McpToolCallResult,
  JsonRpcResponse,
} from './types.js';

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT = 30_000;

export class McpClient {
  private transport: StdioTransport;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (reason: Error) => void;
  }>();
  private serverInfo: McpInitializeResult | null = null;

  constructor(config: McpServerConfig) {
    this.transport = new StdioTransport(config.command, config.args, config.env);
  }

  async connect(): Promise<McpInitializeResult> {
    await this.transport.start();

    this.transport.on('message', (msg: JsonRpcResponse) => {
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const handler = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        handler.resolve(msg);
      }
    });

    const response = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'jam-cli', version: '0.4.0' },
    });

    if (response.error) {
      throw new Error(`MCP initialize failed: ${response.error.message}`);
    }

    this.serverInfo = response.result as McpInitializeResult;

    // Notify server that initialization is complete
    this.transport.send({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    return this.serverInfo;
  }

  async listTools(): Promise<McpToolSchema[]> {
    const response = await this.request('tools/list');
    if (response.error) {
      throw new Error(`MCP tools/list failed: ${response.error.message}`);
    }
    const result = response.result as { tools: McpToolSchema[] };
    return result.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const response = await this.request('tools/call', { name, arguments: args });
    if (response.error) {
      return {
        content: [{ type: 'text', text: `MCP error: ${response.error.message}` }],
        isError: true,
      };
    }
    return response.result as McpToolCallResult;
  }

  getServerInfo(): McpInitializeResult | null {
    return this.serverInfo;
  }

  async close(): Promise<void> {
    for (const [, handler] of this.pending) {
      handler.reject(new Error('MCP client closed'));
    }
    this.pending.clear();
    await this.transport.close();
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, REQUEST_TIMEOUT);

      this.pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.transport.send({ jsonrpc: '2.0', id, method, params });
    });
  }
}
