/**
 * MCP manager — coordinates multiple MCP server connections.
 *
 * Converts MCP tools into jam's provider-facing ToolDefinition format
 * and routes tool calls to the appropriate server.
 *
 * Governance features:
 * - Per-server enabled/disabled
 * - Group-based activation (mcpGroups)
 * - Per-server tool policy (auto/ask/deny)
 * - Per-server allowedTools / deniedTools filtering
 */

import { McpClient } from './client.js';
import type {
  McpServerConfig,
  McpToolPolicy,
  McpToolSchema,
  McpToolCallResult,
} from './types.js';
import type { ToolDefinition } from '../providers/base.js';

/** Prefix for all MCP tool names: mcp__{serverName}__{toolName} */
const MCP_PREFIX = 'mcp__';

interface ConnectedServer {
  name: string;
  client: McpClient;
  tools: McpToolSchema[];
  config: McpServerConfig;
}

export class McpManager {
  private servers = new Map<string, ConnectedServer>();

  /**
   * Connect to configured MCP servers, respecting governance rules.
   * - Skips disabled servers (enabled === false)
   * - Skips servers not in active groups (when mcpGroups is set)
   * Non-fatal — logs errors and continues.
   */
  async connectAll(
    configs: Record<string, McpServerConfig>,
    log?: (msg: string) => void,
    activeGroups?: string[],
  ): Promise<void> {
    const entries = Object.entries(configs);
    if (entries.length === 0) return;

    await Promise.all(
      entries.map(async ([name, config]) => {
        // Skip disabled servers
        if (config.enabled === false) {
          log?.(`MCP: skipping "${name}" (disabled)`);
          return;
        }

        // Skip servers not in active groups (when groups are specified)
        if (activeGroups && activeGroups.length > 0) {
          if (!config.group || !activeGroups.includes(config.group)) {
            log?.(`MCP: skipping "${name}" (group "${config.group ?? 'none'}" not in active groups)`);
            return;
          }
        }

        try {
          const client = new McpClient(config);
          const info = await client.connect();
          const tools = await client.listTools();
          this.servers.set(name, { name, client, tools, config });
          log?.(`MCP: connected to "${name}" (${info.serverInfo.name}) — ${tools.length} tool${tools.length === 1 ? '' : 's'}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log?.(`MCP: failed to connect to "${name}": ${msg}`);
        }
      }),
    );
  }

  /**
   * Get provider-facing tool definitions for all connected MCP servers.
   * Filters tools by per-server allowedTools / deniedTools.
   * Excludes tools from servers with toolPolicy === 'deny'.
   */
  getToolSchemas(): ToolDefinition[] {
    const schemas: ToolDefinition[] = [];
    for (const [serverName, server] of this.servers) {
      // Servers with 'deny' policy expose no tools
      if (server.config.toolPolicy === 'deny') continue;

      for (const tool of server.tools) {
        if (!isToolAllowed(tool.name, server.config)) continue;
        schemas.push(mcpToolToSchema(serverName, tool));
      }
    }
    return schemas;
  }

  /** Check if a tool name belongs to an MCP server. */
  isOwnTool(toolName: string): boolean {
    return toolName.startsWith(MCP_PREFIX);
  }

  /**
   * Get the tool policy for a qualified MCP tool name.
   * Returns the server's toolPolicy, or 'auto' if unknown.
   */
  getToolPolicy(qualifiedName: string): McpToolPolicy {
    const { serverName } = parseMcpToolName(qualifiedName);
    const server = this.servers.get(serverName);
    return server?.config.toolPolicy ?? 'auto';
  }

  /** Execute an MCP tool call. Returns the text output. */
  async executeTool(qualifiedName: string, args: Record<string, unknown>): Promise<string> {
    const { serverName, toolName } = parseMcpToolName(qualifiedName);
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`MCP server "${serverName}" not connected`);
    }

    const result = await server.client.callTool(toolName, args);
    return formatMcpResult(result);
  }

  /** List all connected servers and their tools (respecting filters). */
  listServers(): Array<{
    name: string;
    tools: McpToolSchema[];
    serverInfo: string;
    group?: string;
    toolPolicy: McpToolPolicy;
    totalTools: number;
    filteredTools: number;
  }> {
    return Array.from(this.servers.values()).map((s) => {
      const filtered = s.tools.filter((t) => isToolAllowed(t.name, s.config));
      return {
        name: s.name,
        tools: filtered,
        serverInfo: s.client.getServerInfo()?.serverInfo.name ?? 'unknown',
        group: s.config.group,
        toolPolicy: s.config.toolPolicy ?? 'auto',
        totalTools: s.tools.length,
        filteredTools: filtered.length,
      };
    });
  }

  /** True if any servers are connected. */
  get hasServers(): boolean {
    return this.servers.size > 0;
  }

  /** Shut down all MCP server connections. */
  async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.servers.values()).map((s) => s.client.close()),
    );
    this.servers.clear();
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Check if a tool name passes the server's allowedTools / deniedTools filters. */
function isToolAllowed(toolName: string, config: McpServerConfig): boolean {
  // If allowedTools is set and non-empty, tool must be in the list
  if (config.allowedTools && config.allowedTools.length > 0) {
    if (!config.allowedTools.includes(toolName)) return false;
  }
  // If deniedTools is set, tool must NOT be in the list
  if (config.deniedTools && config.deniedTools.length > 0) {
    if (config.deniedTools.includes(toolName)) return false;
  }
  return true;
}

const VALID_TYPES = new Set(['string', 'number', 'boolean', 'integer', 'array', 'object']);
const MAX_DESCRIPTION_LENGTH = 1000;

function mcpToolToSchema(serverName: string, tool: McpToolSchema): ToolDefinition {
  const properties: Record<string, { type: string; description?: string; enum?: string[] }> = {};

  if (tool.inputSchema.properties) {
    for (const [key, prop] of Object.entries(tool.inputSchema.properties)) {
      // Validate property type
      const propType = VALID_TYPES.has(prop.type) ? prop.type : 'string';
      // Cap description length to prevent context stuffing
      const desc = prop.description?.slice(0, MAX_DESCRIPTION_LENGTH);
      properties[key] = {
        type: propType,
        ...(desc ? { description: desc } : {}),
        ...(prop.enum ? { enum: prop.enum } : {}),
      };
    }
  }

  return {
    name: `${MCP_PREFIX}${serverName}__${tool.name}`,
    description: `[MCP: ${serverName}] ${tool.description ?? tool.name}`,
    parameters: {
      type: 'object',
      properties,
      required: tool.inputSchema.required ?? [],
    },
  };
}

function parseMcpToolName(qualifiedName: string): { serverName: string; toolName: string } {
  const withoutPrefix = qualifiedName.slice(MCP_PREFIX.length);
  const idx = withoutPrefix.indexOf('__');
  if (idx === -1) {
    throw new Error(`Invalid MCP tool name: ${qualifiedName}`);
  }
  return {
    serverName: withoutPrefix.slice(0, idx),
    toolName: withoutPrefix.slice(idx + 2),
  };
}

function formatMcpResult(result: McpToolCallResult): string {
  const parts: string[] = [];
  for (const content of result.content) {
    if (content.type === 'text') {
      parts.push(content.text);
    } else if (content.type === 'image') {
      parts.push(`[Image: ${content.mimeType}]`);
    } else if (content.type === 'resource') {
      parts.push(content.resource.text ?? `[Resource: ${content.resource.uri}]`);
    }
  }
  const output = parts.join('\n');
  return result.isError ? `Error: ${output}` : output;
}

/** Create an MCP manager and connect to configured servers. */
export async function createMcpManager(
  mcpServers: Record<string, McpServerConfig> | undefined,
  log?: (msg: string) => void,
  activeGroups?: string[],
): Promise<McpManager> {
  const manager = new McpManager();
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    await manager.connectAll(mcpServers, log, activeGroups);
  }
  return manager;
}
