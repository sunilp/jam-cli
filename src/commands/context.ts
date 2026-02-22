import { getWorkspaceRoot } from '../utils/workspace.js';
import {
  generateContextContent,
  writeContextFile,
  loadContextFile,
  contextFileExists,
  CONTEXT_FILENAME,
} from '../utils/context.js';
import { printError, printSuccess, renderMarkdown } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';

export interface ContextInitOptions {
  force?: boolean;
}

/**
 * `jam context init` — generate a JAM.md file at the workspace root.
 */
export async function runContextInit(options: ContextInitOptions = {}): Promise<void> {
  try {
    const workspaceRoot = await getWorkspaceRoot();

    if (!options.force && await contextFileExists(workspaceRoot)) {
      await printError(
        `${CONTEXT_FILENAME} already exists. Use --force to overwrite.`
      );
      process.exit(1);
    }

    const content = await generateContextContent(workspaceRoot);
    const path = await writeContextFile(workspaceRoot, content);

    await printSuccess(`Created ${CONTEXT_FILENAME} at: ${path}`);
    process.stderr.write(
      '\nThis file is automatically read by `jam ask` and `jam chat`.\n' +
      'Edit it to add architecture notes, coding conventions, and project-specific context.\n'
    );
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message);
    process.exit(1);
  }
}

/**
 * `jam context show` — display the current JAM.md contents.
 */
export async function runContextShow(): Promise<void> {
  try {
    const workspaceRoot = await getWorkspaceRoot();
    const content = await loadContextFile(workspaceRoot);

    if (!content) {
      await printError(
        `No ${CONTEXT_FILENAME} found. Run \`jam context init\` to generate one.`
      );
      process.exit(1);
    }

    try {
      const rendered = await renderMarkdown(content);
      process.stdout.write(rendered);
    } catch {
      process.stdout.write(content);
    }
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message);
    process.exit(1);
  }
}
