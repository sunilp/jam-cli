import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { withRetry, collectStream } from '../utils/stream.js';
import { printError, printSuccess, printWarning } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import type { CliOverrides } from '../config/schema.js';

const execFileAsync = promisify(execFile);

export interface PatchOptions extends CliOverrides {
  file?: string[];   // files to include as context
  dry?: boolean;     // generate diff but don't offer to apply
  yes?: boolean;     // auto-confirm application
}

async function collectContext(workspaceRoot: string, files?: string[]): Promise<string> {
  if (files && files.length > 0) {
    const parts: string[] = [];
    for (const f of files) {
      try {
        const content = await readFile(f, 'utf-8');
        const rel = relative(workspaceRoot, f);
        parts.push(`### ${rel}\n\`\`\`\n${content}\n\`\`\``);
      } catch {
        // skip unreadable
      }
    }
    return parts.join('\n\n');
  }

  // Auto-collect small context: git status + changed files
  try {
    const { stdout: status } = await execFileAsync('git', ['status', '--short'], {
      cwd: workspaceRoot,
    });
    const { stdout: diff } = await execFileAsync('git', ['diff', 'HEAD'], { cwd: workspaceRoot });
    const parts: string[] = [];
    if (status.trim()) parts.push(`### git status\n\`\`\`\n${status.trim()}\n\`\`\``);
    if (diff.trim()) parts.push(`### Current diff\n\`\`\`diff\n${diff.trim()}\n\`\`\``);
    return parts.join('\n\n');
  } catch {
    return '';
  }
}

function extractDiff(text: string): string | null {
  // Look for unified diff in code blocks
  const codeBlockMatch = text.match(/```(?:diff)?\n(---[\s\S]+?)\n```/);
  if (codeBlockMatch?.[1]) return codeBlockMatch[1];

  // Look for raw unified diff
  const rawMatch = text.match(/(---\s+\S+\s*\n\+\+\+\s+\S+[\s\S]+)/);
  if (rawMatch?.[1]) return rawMatch[1];

  return null;
}

async function validatePatch(patch: string, cwd: string): Promise<boolean> {
  const tmpFile = join(tmpdir(), `jam-patch-${randomUUID()}.patch`);
  try {
    await writeFile(tmpFile, patch, 'utf-8');
    await execFileAsync('git', ['apply', '--check', tmpFile], { cwd });
    return true;
  } catch {
    return false;
  } finally {
    await unlink(tmpFile).catch(() => undefined);
  }
}

async function applyPatch(patch: string, cwd: string): Promise<string> {
  const tmpFile = join(tmpdir(), `jam-patch-${randomUUID()}.patch`);
  try {
    await writeFile(tmpFile, patch, 'utf-8');
    await execFileAsync('git', ['apply', tmpFile], { cwd });
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', 'HEAD'], { cwd }).catch(
      () => ({ stdout: '' })
    );
    return stdout.trim() || 'Changes applied.';
  } finally {
    await unlink(tmpFile).catch(() => undefined);
  }
}

export async function runPatch(instruction: string | undefined, options: PatchOptions): Promise<void> {
  if (!instruction) {
    await printError('Provide a patch instruction. Usage: jam patch "<instruction>"');
    process.exit(1);
  }

  try {
    const workspaceRoot = await getWorkspaceRoot();
    const config = await loadConfig(process.cwd(), options);
    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    const context = await collectContext(workspaceRoot, options.file);

    const prompt =
      `You are a coding assistant. Generate a unified diff patch to accomplish the following:\n\n` +
      `**Instruction:** ${instruction}\n\n` +
      (context ? `**Current codebase context:**\n${context}\n\n` : '') +
      `**Requirements:**\n` +
      `- Output ONLY a valid unified diff (starting with \`---\` and \`+++\` lines)\n` +
      `- Wrap the diff in a code block: \`\`\`diff ... \`\`\`\n` +
      `- Make minimal changes to accomplish the goal\n` +
      `- Ensure the diff is complete and can be applied with \`git apply\``;

    process.stderr.write('Generating patch...\n');
    const { text } = await collectStream(
      withRetry(() =>
        adapter.streamCompletion({
          messages: [{ role: 'user', content: prompt }],
          model: profile.model,
          temperature: profile.temperature ?? 0.2,
          maxTokens: profile.maxTokens,
          systemPrompt: profile.systemPrompt,
        })
      )
    );

    const patch = extractDiff(text);
    if (!patch) {
      await printError(
        'The model did not produce a valid unified diff. Try being more specific in your instruction.'
      );
      process.stderr.write('\nModel response:\n' + text + '\n');
      process.exit(1);
    }

    process.stdout.write('\n--- Generated Patch ---\n');
    process.stdout.write(patch + '\n');
    process.stdout.write('--- End Patch ---\n\n');

    if (options.dry) {
      process.stderr.write('Dry run — patch not applied.\n');
      return;
    }

    const valid = await validatePatch(patch, workspaceRoot);
    if (!valid) {
      await printWarning(
        'Patch does not apply cleanly to the current working tree. It may need manual adjustment.'
      );
      if (!options.yes) {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        const answer = await rl.question('Apply anyway? [y/N] ');
        rl.close();
        if (answer.toLowerCase() !== 'y') {
          process.stderr.write('Patch discarded.\n');
          return;
        }
      }
    } else if (!options.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = await rl.question('Apply this patch? [y/N] ');
      rl.close();
      if (answer.toLowerCase() !== 'y') {
        process.stderr.write('Patch discarded.\n');
        return;
      }
    }

    const changed = await applyPatch(patch, workspaceRoot);
    await printSuccess('Patch applied successfully.');
    if (changed && changed !== 'Changes applied.') {
      process.stderr.write('Changed files:\n' + changed + '\n');
    }
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message);
    process.exit(1);
  }
}
