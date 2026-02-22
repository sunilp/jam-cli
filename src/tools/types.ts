export interface ToolContext {
  workspaceRoot: string;
  cwd: string;
}

export interface ToolResult {
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  readonly: boolean;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; optional?: boolean }>;
    required: string[];
  };
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
