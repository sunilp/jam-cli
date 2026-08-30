import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../mcp/manager.js', () => ({
  McpManager: vi.fn().mockImplementation(() => ({
    connectAll: vi.fn(),
    getToolSchemas: vi.fn().mockReturnValue([]),
    executeTool: vi.fn().mockResolvedValue('ok'),
    isOwnTool: vi.fn().mockReturnValue(true),
    shutdown: vi.fn(),
  })),
}));

import { BrowserBridge } from './bridge.js';
import { McpManager } from '../mcp/manager.js';

describe('BrowserBridge', () => {
  let bridge: BrowserBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new BrowserBridge();
  });

  afterEach(async () => {
    try { await bridge.disconnect(); } catch { /* ignore */ }
  });

  describe('connect', () => {
    it('should start the Playwright MCP server with default command', async () => {
      await bridge.connect();
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      expect(managerInstance.connectAll).toHaveBeenCalledWith(
        expect.objectContaining({
          playwright: expect.objectContaining({
            command: 'npx',
            args: expect.arrayContaining(['@anthropic-ai/mcp-playwright']),
          }),
        }),
        expect.any(Function),
        undefined,
      );
    });

    it('should accept custom command override', async () => {
      bridge = new BrowserBridge({ command: 'my-playwright', args: ['--headless'] });
      await bridge.connect();
      const managerInstance = vi.mocked(McpManager).mock.results[1].value;
      expect(managerInstance.connectAll).toHaveBeenCalledWith(
        expect.objectContaining({
          playwright: expect.objectContaining({
            command: 'my-playwright',
            args: ['--headless'],
          }),
        }),
        expect.any(Function),
        undefined,
      );
    });
  });

  describe('getToolSchemas', () => {
    it('should strip mcp__playwright__ prefix from tool names', async () => {
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      managerInstance.getToolSchemas.mockReturnValue([
        { name: 'mcp__playwright__browser_click', description: 'Click', readonly: false, parameters: { type: 'object', properties: {}, required: [] } },
        { name: 'mcp__playwright__browser_navigate', description: 'Navigate', readonly: false, parameters: { type: 'object', properties: {}, required: [] } },
      ]);

      await bridge.connect();
      const schemas = bridge.getToolSchemas();

      expect(schemas[0].name).toBe('browser_click');
      expect(schemas[1].name).toBe('browser_navigate');
    });
  });

  describe('executeTool', () => {
    it('should re-add mcp__playwright__ prefix when calling MCP manager', async () => {
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      managerInstance.getToolSchemas.mockReturnValue([]);
      await bridge.connect();

      await bridge.executeTool('browser_click', { selector: '#btn' });

      expect(managerInstance.executeTool).toHaveBeenCalledWith(
        'mcp__playwright__browser_click',
        { selector: '#btn' },
      );
    });
  });

  describe('convenience methods', () => {
    it('navigate should call browser_navigate', async () => {
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      managerInstance.getToolSchemas.mockReturnValue([]);
      await bridge.connect();

      await bridge.navigate('https://example.com');

      expect(managerInstance.executeTool).toHaveBeenCalledWith(
        'mcp__playwright__browser_navigate',
        { url: 'https://example.com' },
      );
    });

    it('snapshot should call browser_snapshot', async () => {
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      managerInstance.getToolSchemas.mockReturnValue([]);
      await bridge.connect();

      await bridge.snapshot();

      expect(managerInstance.executeTool).toHaveBeenCalledWith(
        'mcp__playwright__browser_snapshot',
        {},
      );
    });

    it('click should call browser_click', async () => {
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      managerInstance.getToolSchemas.mockReturnValue([]);
      await bridge.connect();

      await bridge.click('button[type="submit"]');

      expect(managerInstance.executeTool).toHaveBeenCalledWith(
        'mcp__playwright__browser_click',
        { element: 'button[type="submit"]' },
      );
    });

    it('fill should call browser_fill_form', async () => {
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      managerInstance.getToolSchemas.mockReturnValue([]);
      await bridge.connect();

      await bridge.fill('#email', 'user@example.com');

      expect(managerInstance.executeTool).toHaveBeenCalledWith(
        'mcp__playwright__browser_fill_form',
        { selector: '#email', value: 'user@example.com' },
      );
    });
  });

  describe('disconnect', () => {
    it('should shut down the MCP manager', async () => {
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      managerInstance.getToolSchemas.mockReturnValue([]);
      await bridge.connect();

      await bridge.disconnect();

      expect(managerInstance.shutdown).toHaveBeenCalled();
    });
  });
});
