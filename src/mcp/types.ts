/**
 * MCP (Model Context Protocol) types.
 *
 * Lightweight JSON-RPC 2.0 + MCP-specific types.
 * No external SDK dependency — just the wire format.
 */

// ── JSON-RPC 2.0 ────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ── MCP config ───────────────────────────────────────────────────────────────

export type McpToolPolicy = 'auto' | 'ask' | 'deny';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Whether this server is enabled (default: true). */
  enabled?: boolean;
  /** Group tag for this server (e.g. 'code', 'jira', 'db', 'browser'). */
  group?: string;
  /** Tool approval policy for this server (default: 'auto'). */
  toolPolicy?: McpToolPolicy;
  /** Only expose these tools from this server (allowlist). */
  allowedTools?: string[];
  /** Hide these tools from this server (denylist). */
  deniedTools?: string[];
}

// ── MCP protocol types ───────────────────────────────────────────────────────

export interface McpServerInfo {
  name: string;
  version?: string;
}

export interface McpCapabilities {
  tools?: Record<string, never>;
  resources?: Record<string, never>;
  prompts?: Record<string, never>;
}

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: McpCapabilities;
  serverInfo: McpServerInfo;
}

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, McpPropertySchema>;
    required?: string[];
  };
}

export interface McpPropertySchema {
  type: string;
  description?: string;
  enum?: string[];
}

export interface McpToolCallResult {
  content: McpContent[];
  isError?: boolean;
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; text?: string; blob?: string } };
