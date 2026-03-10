import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpManager } from './manager.js';
import type { McpToolSchema } from './types.js';

// ── Mock the McpClient ────────────────────────────────────────────────────────

const mockConnect = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn();
const mockGetServerInfo = vi.fn();

vi.mock('./client.js', () => ({
  McpClient: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    listTools: mockListTools,
    callTool: mockCallTool,
    close: mockClose,
    getServerInfo: mockGetServerInfo,
  })),
}));

describe('McpManager', () => {
  let manager: McpManager;

  const sampleTools: McpToolSchema[] = [
    {
      name: 'read_query',
      description: 'Execute a read-only SQL query',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The SQL query to execute' },
        },
        required: ['query'],
      },
    },
    {
      name: 'list_tables',
      description: 'List all database tables',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'write_query',
      description: 'Execute a write SQL query',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The SQL query to execute' },
        },
        required: ['query'],
      },
    },
  ];

  beforeEach(() => {
    manager = new McpManager();
    vi.clearAllMocks();

    mockConnect.mockResolvedValue({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'test-server', version: '1.0.0' },
    });
    mockListTools.mockResolvedValue(sampleTools);
    mockGetServerInfo.mockReturnValue({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'test-server', version: '1.0.0' },
    });
    mockClose.mockResolvedValue(undefined);
  });

  describe('connectAll', () => {
    it('connects to configured servers and discovers tools', async () => {
      await manager.connectAll({
        postgres: { command: 'node', args: ['server.js'] },
      });

      expect(manager.hasServers).toBe(true);
      expect(manager.listServers()).toHaveLength(1);
      expect(manager.listServers()[0]).toMatchObject({
        name: 'postgres',
        serverInfo: 'test-server',
      });
    });

    it('continues if a server fails to connect', async () => {
      mockConnect
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'good-server' },
        });

      const logs: string[] = [];
      await manager.connectAll(
        {
          broken: { command: 'nonexistent' },
          working: { command: 'node', args: ['server.js'] },
        },
        (msg) => logs.push(msg),
      );

      expect(manager.listServers()).toHaveLength(1);
      expect(manager.listServers()[0]!.name).toBe('working');
      expect(logs.some((l) => l.includes('failed to connect to "broken"'))).toBe(true);
      expect(logs.some((l) => l.includes('connected to "working"'))).toBe(true);
    });

    it('handles empty config', async () => {
      await manager.connectAll({});
      expect(manager.hasServers).toBe(false);
    });

    it('skips disabled servers', async () => {
      const logs: string[] = [];
      await manager.connectAll(
        {
          disabled: { command: 'node', enabled: false },
          enabled: { command: 'node', args: ['server.js'] },
        },
        (msg) => logs.push(msg),
      );

      expect(manager.listServers()).toHaveLength(1);
      expect(manager.listServers()[0]!.name).toBe('enabled');
      expect(logs.some((l) => l.includes('skipping "disabled" (disabled)'))).toBe(true);
    });

    it('filters by active groups', async () => {
      const logs: string[] = [];
      await manager.connectAll(
        {
          codeServer: { command: 'node', group: 'code' },
          dbServer: { command: 'node', group: 'db' },
          noGroup: { command: 'node' },
        },
        (msg) => logs.push(msg),
        ['code'],
      );

      expect(manager.listServers()).toHaveLength(1);
      expect(manager.listServers()[0]!.name).toBe('codeServer');
      expect(logs.some((l) => l.includes('skipping "dbServer"'))).toBe(true);
      expect(logs.some((l) => l.includes('skipping "noGroup"'))).toBe(true);
    });

    it('connects all enabled servers when no groups specified', async () => {
      await manager.connectAll({
        a: { command: 'node', group: 'code' },
        b: { command: 'node', group: 'db' },
        c: { command: 'node' },
      });

      expect(manager.listServers()).toHaveLength(3);
    });
  });

  describe('getToolSchemas', () => {
    it('converts MCP tools to provider-facing schemas with prefixed names', async () => {
      await manager.connectAll({ db: { command: 'node' } });
      const schemas = manager.getToolSchemas();

      expect(schemas).toHaveLength(3);
      expect(schemas[0]).toMatchObject({
        name: 'mcp__db__read_query',
        description: '[MCP: db] Execute a read-only SQL query',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The SQL query to execute' },
          },
          required: ['query'],
        },
      });
      expect(schemas[1]).toMatchObject({
        name: 'mcp__db__list_tables',
        description: '[MCP: db] List all database tables',
      });
    });

    it('returns empty array when no servers connected', () => {
      expect(manager.getToolSchemas()).toEqual([]);
    });

    it('filters tools by allowedTools', async () => {
      await manager.connectAll({
        db: { command: 'node', allowedTools: ['read_query', 'list_tables'] },
      });
      const schemas = manager.getToolSchemas();

      expect(schemas).toHaveLength(2);
      expect(schemas.map((s) => s.name)).toEqual([
        'mcp__db__read_query',
        'mcp__db__list_tables',
      ]);
    });

    it('filters tools by deniedTools', async () => {
      await manager.connectAll({
        db: { command: 'node', deniedTools: ['write_query'] },
      });
      const schemas = manager.getToolSchemas();

      expect(schemas).toHaveLength(2);
      expect(schemas.map((s) => s.name)).toEqual([
        'mcp__db__read_query',
        'mcp__db__list_tables',
      ]);
    });

    it('excludes all tools when server policy is deny', async () => {
      await manager.connectAll({
        db: { command: 'node', toolPolicy: 'deny' },
      });
      const schemas = manager.getToolSchemas();

      expect(schemas).toHaveLength(0);
    });

    it('allowedTools takes precedence over deniedTools', async () => {
      await manager.connectAll({
        db: {
          command: 'node',
          allowedTools: ['read_query'],
          deniedTools: ['read_query'],
        },
      });
      const schemas = manager.getToolSchemas();

      // deniedTools blocks it even if allowedTools includes it
      expect(schemas).toHaveLength(0);
    });
  });

  describe('isOwnTool', () => {
    it('recognizes MCP-prefixed tool names', () => {
      expect(manager.isOwnTool('mcp__db__read_query')).toBe(true);
      expect(manager.isOwnTool('mcp__fs__read_file')).toBe(true);
    });

    it('rejects non-MCP tool names', () => {
      expect(manager.isOwnTool('read_file')).toBe(false);
      expect(manager.isOwnTool('write_file')).toBe(false);
      expect(manager.isOwnTool('search_text')).toBe(false);
    });
  });

  describe('getToolPolicy', () => {
    it('returns the server tool policy', async () => {
      await manager.connectAll({
        askServer: { command: 'node', toolPolicy: 'ask' },
        denyServer: { command: 'node', toolPolicy: 'deny' },
        autoServer: { command: 'node' },
      });

      expect(manager.getToolPolicy('mcp__askServer__some_tool')).toBe('ask');
      expect(manager.getToolPolicy('mcp__denyServer__some_tool')).toBe('deny');
      expect(manager.getToolPolicy('mcp__autoServer__some_tool')).toBe('auto');
    });

    it('returns auto for unknown servers', () => {
      expect(manager.getToolPolicy('mcp__unknown__tool')).toBe('auto');
    });
  });

  describe('executeTool', () => {
    it('routes tool calls to the correct server', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'id | name\n1 | Alice' }],
      });

      await manager.connectAll({ db: { command: 'node' } });
      const result = await manager.executeTool('mcp__db__read_query', { query: 'SELECT * FROM users' });

      expect(mockCallTool).toHaveBeenCalledWith('read_query', { query: 'SELECT * FROM users' });
      expect(result).toBe('id | name\n1 | Alice');
    });

    it('returns error text for MCP errors', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'syntax error at position 5' }],
        isError: true,
      });

      await manager.connectAll({ db: { command: 'node' } });
      const result = await manager.executeTool('mcp__db__read_query', { query: 'SELEC' });

      expect(result).toBe('Error: syntax error at position 5');
    });

    it('throws for unknown server', async () => {
      await expect(
        manager.executeTool('mcp__unknown__tool', {}),
      ).rejects.toThrow('MCP server "unknown" not connected');
    });

    it('handles multi-content responses', async () => {
      mockCallTool.mockResolvedValue({
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
          { type: 'image', data: 'base64...', mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'file:///tmp/out.txt', text: 'resource content' } },
        ],
      });

      await manager.connectAll({ db: { command: 'node' } });
      const result = await manager.executeTool('mcp__db__read_query', { query: 'test' });

      expect(result).toBe('Part 1\nPart 2\n[Image: image/png]\nresource content');
    });
  });

  describe('listServers', () => {
    it('includes governance info in server listing', async () => {
      await manager.connectAll({
        db: { command: 'node', group: 'database', toolPolicy: 'ask', allowedTools: ['read_query'] },
      });

      const servers = manager.listServers();
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({
        name: 'db',
        group: 'database',
        toolPolicy: 'ask',
        totalTools: 3,
        filteredTools: 1,
      });
      expect(servers[0]!.tools).toHaveLength(1);
      expect(servers[0]!.tools[0]!.name).toBe('read_query');
    });
  });

  describe('shutdown', () => {
    it('closes all server connections', async () => {
      await manager.connectAll({
        db: { command: 'node' },
        fs: { command: 'node' },
      });

      await manager.shutdown();

      expect(mockClose).toHaveBeenCalledTimes(2);
      expect(manager.hasServers).toBe(false);
    });
  });
});
