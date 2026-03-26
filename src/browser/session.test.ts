import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./bridge.js', () => ({
  BrowserBridge: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue('Navigated'),
    snapshot: vi.fn().mockResolvedValue('Page snapshot: button "Submit"'),
    screenshot: vi.fn().mockResolvedValue('Screenshot saved'),
    getToolSchemas: vi.fn().mockReturnValue([
      { name: 'browser_navigate', description: 'Navigate', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'browser_click', description: 'Click', inputSchema: { type: 'object', properties: {}, required: [] } },
    ]),
    executeTool: vi.fn().mockResolvedValue('ok'),
  })),
}));

vi.mock('../config/loader.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({ mcpServers: {} }),
  getActiveProfile: vi.fn().mockReturnValue({ provider: 'ollama', model: 'llama3.2' }),
}));

vi.mock('../providers/factory.js', () => ({
  createProvider: vi.fn().mockResolvedValue({
    info: { name: 'ollama', supportsStreaming: true, supportsTools: true },
    chatWithTools: vi.fn(),
  }),
  blockIfNoToolSupport: vi.fn(),
}));

import { BrowserSession } from './session.js';
import { BrowserBridge } from './bridge.js';

describe('BrowserSession', () => {
  let session: BrowserSession;
  let mockBridge: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    navigate: ReturnType<typeof vi.fn>;
    snapshot: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    getToolSchemas: ReturnType<typeof vi.fn>;
    executeTool: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    session = new BrowserSession({});
    mockBridge = vi.mocked(BrowserBridge).mock.results[0]?.value;
  });

  describe('start', () => {
    it('should connect to the Playwright MCP bridge', async () => {
      await session.start();
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    it('should navigate to initial URL if provided', async () => {
      session = new BrowserSession({ url: 'https://example.com' });
      mockBridge = vi.mocked(BrowserBridge).mock.results[1]?.value;

      await session.start();
      expect(mockBridge.navigate).toHaveBeenCalledWith('https://example.com');
    });
  });

  describe('handleSlashCommand', () => {
    it('should handle /screenshot', async () => {
      await session.start();
      const result = await session.handleSlashCommand('/screenshot');
      expect(result).toBe('handled');
      expect(mockBridge.screenshot).toHaveBeenCalled();
    });

    it('should handle /snapshot', async () => {
      await session.start();
      const result = await session.handleSlashCommand('/snapshot');
      expect(result).toBe('handled');
      expect(mockBridge.snapshot).toHaveBeenCalled();
    });

    it('should handle /back', async () => {
      await session.start();
      const result = await session.handleSlashCommand('/back');
      expect(result).toBe('handled');
      expect(mockBridge.executeTool).toHaveBeenCalledWith('browser_navigate_back', {});
    });

    it('should handle /tabs', async () => {
      await session.start();
      const result = await session.handleSlashCommand('/tabs');
      expect(result).toBe('handled');
      expect(mockBridge.executeTool).toHaveBeenCalledWith('browser_tabs', {});
    });

    it('should return "exit" for /exit', async () => {
      await session.start();
      const result = await session.handleSlashCommand('/exit');
      expect(result).toBe('exit');
    });

    it('should return "unknown" for unrecognized commands', async () => {
      await session.start();
      const result = await session.handleSlashCommand('/foo');
      expect(result).toBe('unknown');
    });
  });

  describe('stop', () => {
    it('should disconnect the bridge', async () => {
      await session.start();
      await session.stop();
      expect(mockBridge.disconnect).toHaveBeenCalled();
    });
  });
});
