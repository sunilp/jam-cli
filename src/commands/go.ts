/**
 * `jam go` — Claude Code-like interactive agent session.
 *
 * Like `jam chat` but with full write tools (write_file, apply_patch,
 * run_command, git operations). Permission prompts before dangerous operations.
 */

import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { createSession } from '../storage/history.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import { startChat } from '../ui/chat.js';
import { createMcpManager } from '../mcp/manager.js';
import { JamError } from '../utils/errors.js';
import type { Message } from '../providers/base.js';

export interface GoCommandOptions {
  profile?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  name?: string;
}

export async function runGo(options: GoCommandOptions): Promise<void> {
  try {
    const config = await loadConfig(process.cwd(), {
      profile: options.profile,
      provider: options.provider,
      model: options.model,
      baseUrl: options.baseUrl,
    });

    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    const workspaceRoot = await getWorkspaceRoot(process.cwd());
    const sessionName =
      options.name ?? `Agent ${new Date().toLocaleString('en-US', { hour12: false })}`;
    const session = await createSession(sessionName, workspaceRoot);

    let initialMessages: Message[] = [];
    if (profile.systemPrompt) {
      initialMessages = [{ role: 'system', content: profile.systemPrompt }];
    }

    const mcpLog = (msg: string) => process.stderr.write(msg + '\n');
    const mcpManager = await createMcpManager(config.mcpServers, mcpLog, config.mcpGroups);

    try {
      await startChat({
        provider: adapter,
        config,
        sessionId: session.id,
        initialMessages,
        mcpManager,
        enableWriteTools: true,
        toolPolicy: config.toolPolicy,
        toolAllowlist: config.toolAllowlist,
      });
    } finally {
      await mcpManager.shutdown();
    }
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    process.stderr.write(`Error: ${jamErr.message}\n`);
    process.exit(1);
  }
}
