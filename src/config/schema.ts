import { z } from 'zod';

export const ToolPolicySchema = z.enum(['ask_every_time', 'allowlist', 'never', 'always']);
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

export const ProfileSchema = z.object({
  provider: z.string().default('ollama'),
  model: z.string().optional(),
  baseUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  systemPrompt: z.string().optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const CommitConventionSchema = z.object({
  /** The format pattern for commit messages.
   *  Use placeholders: {type}, {scope}, {description}, {ticket}, {body}
   *  Examples:
   *    "{type}({scope}): {description}"              — conventional commits
   *    "{ticket}: {description}"                      — JIRA-style
   *    "[{ticket}] {type}: {description}"             — ticket + type
   *    "{type}: {description}"                        — simple conventional
   */
  format: z.string().optional(),
  /** Allowed commit types (e.g. feat, fix, chore). Empty = any. */
  types: z.array(z.string()).optional(),
  /** Regex pattern that ticket/issue IDs follow (e.g. "PROJ-\\d+", "GH-\\d+"). */
  ticketPattern: z.string().optional(),
  /** Whether the ticket is required in every commit. */
  ticketRequired: z.boolean().optional(),
  /** Extra instructions appended to the AI system prompt for commit generation. */
  rules: z.array(z.string()).optional(),
  /** If true, auto-detect convention from recent git history (default: true). */
  autoDetect: z.boolean().optional(),
}).optional();
export type CommitConvention = z.infer<typeof CommitConventionSchema>;

export const McpToolPolicySchema = z.enum(['auto', 'ask', 'deny']);
export type McpToolPolicy = z.infer<typeof McpToolPolicySchema>;

export const McpServerConfigSchema = z.object({
  /** The command to start the MCP server (e.g. "npx", "node", "python"). */
  command: z.string(),
  /** Arguments to pass to the command. */
  args: z.array(z.string()).optional(),
  /** Extra environment variables to set for the server process. */
  env: z.record(z.string()).optional(),
  /** Whether this server is enabled (default: true). */
  enabled: z.boolean().default(true),
  /** Group tag for this server (e.g. 'code', 'jira', 'db', 'browser'). */
  group: z.string().optional(),
  /** Tool approval policy: 'auto' (follow global), 'ask' (confirm each), 'deny' (block all). */
  toolPolicy: McpToolPolicySchema.default('auto'),
  /** Only expose these tools from this server (allowlist). Empty = all. */
  allowedTools: z.array(z.string()).optional(),
  /** Hide these tools from this server (denylist). */
  deniedTools: z.array(z.string()).optional(),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const JiraConfigSchema = z.object({
  /** Jira base URL (e.g. https://jira.company.com or https://yourteam.atlassian.net) */
  baseUrl: z.string().url(),
  /** Email address for Jira authentication (cloud) or username (on-prem). */
  email: z.string(),
  /** API token (cloud) or personal access token (on-prem).
   *  Can also be set via JIRA_API_TOKEN env var. */
  apiToken: z.string().optional(),
  /** Default JQL filter appended to issue queries. */
  defaultJql: z.string().optional(),
  /** Branch name template. Placeholders: {key}, {type}, {summary}
   *  Default: "{key}-{summary}" */
  branchTemplate: z.string().optional(),
}).optional();
export type JiraConfig = z.infer<typeof JiraConfigSchema>;

export const JamConfigSchema = z.object({
  defaultProfile: z.string().default('default'),
  profiles: z.record(ProfileSchema).default({}),
  toolPolicy: ToolPolicySchema.default('ask_every_time'),
  toolAllowlist: z.array(z.string()).default([]),
  historyEnabled: z.boolean().default(true),
  logLevel: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('warn'),
  redactPatterns: z.array(z.string()).default([]),
  commitConvention: CommitConventionSchema,
  jira: JiraConfigSchema,
  /** MCP server declarations — each key is a server name. */
  mcpServers: z.record(McpServerConfigSchema).optional(),
  /** Active MCP server groups. Only servers in these groups are connected.
   *  If omitted, all enabled servers are connected regardless of group. */
  mcpGroups: z.array(z.string()).optional(),
  /** Enable response caching to avoid redundant API calls (default: true). */
  cacheEnabled: z.boolean().default(true),
  /** Cache TTL in seconds (default: 3600 = 1 hour). */
  cacheTtlSeconds: z.number().int().positive().default(3600),
});
export type JamConfig = z.infer<typeof JamConfigSchema>;

export type CliOverrides = {
  profile?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  json?: boolean;
  noColor?: boolean;
};
