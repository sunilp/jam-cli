import { McpManager } from '../mcp/manager.js';
import type { ToolDefinition } from '../providers/base.js';
import type { BrowserBridgeOptions } from './types.js';

const MCP_SERVER_NAME = 'playwright';
const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const DEFAULT_COMMAND = 'npx';
const DEFAULT_ARGS = ['@anthropic-ai/mcp-playwright'];

export class BrowserBridge {
  private manager: McpManager;
  private options: BrowserBridgeOptions;
  private connected = false;

  constructor(options: BrowserBridgeOptions = {}) {
    this.options = options;
    this.manager = new McpManager();
  }

  async connect(): Promise<void> {
    const log = this.options.log ?? (() => {});
    await this.manager.connectAll(
      {
        [MCP_SERVER_NAME]: {
          command: this.options.command ?? DEFAULT_COMMAND,
          args: this.options.args ?? DEFAULT_ARGS,
        },
      },
      log,
      undefined,
    );
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.manager.shutdown();
      this.connected = false;
    }
  }

  /** Get tool schemas with mcp__playwright__ prefix stripped */
  getToolSchemas(): ToolDefinition[] {
    return this.manager.getToolSchemas().map((schema) => ({
      ...schema,
      name: schema.name.startsWith(MCP_PREFIX)
        ? schema.name.slice(MCP_PREFIX.length)
        : schema.name,
    }));
  }

  /** Execute a tool, re-adding the MCP prefix */
  async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const qualifiedName = name.startsWith(MCP_PREFIX) ? name : `${MCP_PREFIX}${name}`;
    return this.manager.executeTool(qualifiedName, args);
  }

  // ── Convenience wrappers ──────────────────────────────────────────────────

  async navigate(url: string): Promise<string> {
    return this.executeTool('browser_navigate', { url });
  }

  async click(selector: string): Promise<string> {
    return this.executeTool('browser_click', { element: selector });
  }

  async fill(selector: string, value: string): Promise<string> {
    return this.executeTool('browser_fill_form', { selector, value });
  }

  async type(text: string): Promise<string> {
    return this.executeTool('browser_type', { text });
  }

  async pressKey(key: string): Promise<string> {
    return this.executeTool('browser_press_key', { key });
  }

  async snapshot(): Promise<string> {
    return this.executeTool('browser_snapshot', {});
  }

  async screenshot(): Promise<string> {
    return this.executeTool('browser_take_screenshot', {});
  }

  async evaluate(script: string): Promise<string> {
    return this.executeTool('browser_evaluate', { script });
  }
}
