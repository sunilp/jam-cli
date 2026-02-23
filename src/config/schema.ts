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

export const JamConfigSchema = z.object({
  defaultProfile: z.string().default('default'),
  profiles: z.record(ProfileSchema).default({}),
  toolPolicy: ToolPolicySchema.default('ask_every_time'),
  toolAllowlist: z.array(z.string()).default([]),
  historyEnabled: z.boolean().default(true),
  logLevel: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('warn'),
  redactPatterns: z.array(z.string()).default([]),
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
