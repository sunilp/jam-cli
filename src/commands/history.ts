import { listSessions, getSession } from '../storage/history.js';
import { JamError } from '../utils/errors.js';

function truncateId(id: string, len = 8): string {
  return id.slice(0, len);
}

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export async function runHistoryList(): Promise<void> {
  const chalk = (await import('chalk')).default;

  try {
    const sessions = await listSessions();

    if (sessions.length === 0) {
      process.stdout.write(chalk.dim('No chat sessions found.\n'));
      return;
    }

    // Header
    const idHeader = chalk.bold('ID      ');
    const nameHeader = chalk.bold('Name                          ');
    const dateHeader = chalk.bold('Date                    ');
    const countHeader = chalk.bold('Messages');
    process.stdout.write(`${idHeader}  ${nameHeader}  ${dateHeader}  ${countHeader}\n`);
    process.stdout.write(chalk.dim('─'.repeat(74) + '\n'));

    for (const session of sessions) {
      const id = chalk.cyan(truncateId(session.id).padEnd(8));
      const name = session.name.slice(0, 30).padEnd(30);
      const date = formatDate(session.updatedAt).padEnd(24);
      const count = chalk.yellow(String(session.messageCount).padStart(8));
      process.stdout.write(`${id}  ${name}  ${date}  ${count}\n`);
    }
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    process.stderr.write(`Error: ${jamErr.message}\n`);
    process.exit(1);
  }
}

export async function runHistoryShow(sessionId: string): Promise<void> {
  const chalk = (await import('chalk')).default;

  try {
    // Support partial IDs — find the first session whose ID starts with sessionId
    let resolvedId = sessionId;
    if (sessionId.length < 36) {
      const sessions = await listSessions();
      const match = sessions.find((s) => s.id.startsWith(sessionId));
      if (!match) {
        throw new JamError(
          `Session "${sessionId}" not found. Use "jam history list" to see available sessions.`,
          'CONFIG_NOT_FOUND'
        );
      }
      resolvedId = match.id;
    }

    const session = await getSession(resolvedId);
    if (!session) {
      throw new JamError(
        `Session "${sessionId}" not found. Use "jam history list" to see available sessions.`,
        'CONFIG_NOT_FOUND'
      );
    }

    process.stdout.write(chalk.bold(`Session: ${session.name}\n`));
    process.stdout.write(chalk.dim(`ID: ${session.id}\n`));
    process.stdout.write(chalk.dim(`Workspace: ${session.workspaceRoot}\n`));
    process.stdout.write(chalk.dim(`Created: ${formatDate(session.createdAt)}\n`));
    process.stdout.write(chalk.dim(`Messages: ${session.messageCount}\n`));
    process.stdout.write(chalk.dim('─'.repeat(60) + '\n\n'));

    if (session.messages.length === 0) {
      process.stdout.write(chalk.dim('No messages in this session.\n'));
      return;
    }

    for (const message of session.messages) {
      const timestamp = chalk.dim(`[${formatDate(message.timestamp)}]`);

      if (message.role === 'user') {
        process.stdout.write(`${chalk.blue.bold('You')} ${timestamp}\n`);
        process.stdout.write(`${chalk.blue(message.content)}\n\n`);
      } else if (message.role === 'assistant') {
        process.stdout.write(`${chalk.green.bold('Jam')} ${timestamp}\n`);
        process.stdout.write(`${chalk.green(message.content)}\n\n`);
      } else if (message.role === 'system') {
        process.stdout.write(`${chalk.dim.bold('System')} ${timestamp}\n`);
        process.stdout.write(`${chalk.dim(message.content)}\n\n`);
      }
    }
  } catch (err) {
    if (JamError.isJamError(err)) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
    const jamErr = JamError.fromUnknown(err);
    process.stderr.write(`Error: ${jamErr.message}\n`);
    process.exit(1);
  }
}
