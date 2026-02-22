import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { createSession, getSession } from '../storage/history.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import { startChat } from '../ui/chat.js';
import { JamError } from '../utils/errors.js';
import type { Message } from '../providers/base.js';

export interface ChatCommandOptions {
  profile?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  resume?: string;
  name?: string;
}

export async function runChat(options: ChatCommandOptions): Promise<void> {
  try {
    const config = await loadConfig(process.cwd(), {
      profile: options.profile,
      provider: options.provider,
      model: options.model,
      baseUrl: options.baseUrl,
    });

    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    let sessionId: string;
    let initialMessages: Message[] = [];

    if (options.resume) {
      // Load existing session
      const existingSession = await getSession(options.resume);
      if (!existingSession) {
        throw new JamError(
          `Session "${options.resume}" not found. Use "jam history list" to see available sessions.`,
          'CONFIG_NOT_FOUND'
        );
      }
      sessionId = existingSession.id;
      // Convert stored messages back to provider Message format
      initialMessages = existingSession.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
    } else {
      // Create a new session
      const workspaceRoot = await getWorkspaceRoot(process.cwd());
      const sessionName =
        options.name ?? `Chat ${new Date().toLocaleString('en-US', { hour12: false })}`;
      const session = await createSession(sessionName, workspaceRoot);
      sessionId = session.id;
      initialMessages = [];

      // Prepend system prompt if configured
      if (profile.systemPrompt) {
        initialMessages = [{ role: 'system', content: profile.systemPrompt }];
      }
    }

    await startChat({
      provider: adapter,
      config,
      sessionId,
      initialMessages,
    });
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    process.stderr.write(`Error: ${jamErr.message}\n`);
    process.exit(1);
  }
}
