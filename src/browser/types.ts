export interface BrowserBridgeOptions {
  /** MCP server command override (default: npx @anthropic-ai/mcp-playwright) */
  command?: string;
  /** MCP server args override */
  args?: string[];
  /** Log function for MCP status messages */
  log?: (msg: string) => void;
}

export interface SessionStep {
  index: number;
  action: string;
  args: Record<string, unknown>;
  timestamp: string;
  url: string;
  note?: string;
}

export interface SessionFile {
  version: 1;
  metadata: SessionMetadata;
  steps: SessionStep[];
}

export interface SessionMetadata {
  name: string;
  createdAt: string;
  startUrl: string;
  steps: number;
  duration: string;
}

/** Options for jam browser launch / record commands */
export interface BrowserCommandOptions {
  profile?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  url?: string;
  output?: string;
}
