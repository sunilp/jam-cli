// src/commands/browser.ts
import * as readline from 'node:readline';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserSession } from '../browser/session.js';
import { SessionRecorder } from '../browser/recorder.js';
import { renderMarkdown, printError } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import type { BrowserCommandOptions } from '../browser/types.js';

export async function runBrowserLaunch(options: BrowserCommandOptions, initialPrompt?: string): Promise<void> {
  const session = new BrowserSession(options);

  try {
    process.stderr.write('\njam browser\n');
    process.stderr.write('Starting Playwright MCP bridge...\n');
    await session.start();
    process.stderr.write('Browser ready. Type a command, or /help.\n\n');

    if (initialPrompt) {
      const result = await session.processCommand(initialPrompt);
      await renderMarkdown(result.response);
    }

    await runRepl(session, null);
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message, jamErr.hint);
  } finally {
    await session.stop();
  }
}

export async function runBrowserRecord(options: BrowserCommandOptions): Promise<void> {
  const session = new BrowserSession(options);
  const recorder = new SessionRecorder({
    name: options.output?.replace(/\.jam-session\.json$/, '') ?? `session-${Date.now()}`,
    startUrl: options.url ?? '',
  });

  try {
    process.stderr.write('\njam browser record\n');
    process.stderr.write('Starting Playwright MCP bridge...\n');
    await session.start();
    process.stderr.write('Recording. Type a command, or /help.\n\n');

    await runRepl(session, recorder);

    // Save session on exit
    const sessionFile = recorder.toSessionFile();
    const outputDir = join(process.cwd(), '.jam', 'sessions');
    mkdirSync(outputDir, { recursive: true });
    const outputPath = options.output
      ? (options.output.endsWith('.json') ? options.output : `${options.output}.jam-session.json`)
      : join(outputDir, `${sessionFile.metadata.name}.jam-session.json`);
    writeFileSync(outputPath, JSON.stringify(sessionFile, null, 2));
    process.stderr.write(`\nSession saved: ${outputPath}\n`);
    process.stderr.write(`${sessionFile.metadata.steps} steps, ${sessionFile.metadata.duration}\n`);
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message, jamErr.hint);
  } finally {
    await session.stop();
  }
}

async function runRepl(session: BrowserSession, recorder: SessionRecorder | null): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: 'browser> ',
  });

  return new Promise<void>((resolve) => {
    rl.prompt();

    rl.on('line', (line) => {
      void (async () => {
        const input = line.trim();
        if (!input) { rl.prompt(); return; }

        // Recorder-specific slash commands
        if (recorder) {
          if (input.startsWith('/note ')) {
            recorder.annotate(input.slice(6));
            process.stderr.write('Note added.\n');
            rl.prompt();
            return;
          }
          if (input === '/pause') {
            recorder.pause();
            process.stderr.write('Recording paused.\n');
            rl.prompt();
            return;
          }
          if (input === '/resume') {
            recorder.resume();
            process.stderr.write('Recording resumed.\n');
            rl.prompt();
            return;
          }
          if (input === '/steps') {
            const steps = recorder.getSteps();
            if (steps.length === 0) {
              process.stderr.write('No steps recorded yet.\n');
            } else {
              for (const step of steps) {
                const note = step.note ? ` — ${step.note}` : '';
                process.stderr.write(`  ${step.index}. ${step.action}${note}\n`);
              }
            }
            rl.prompt();
            return;
          }
          if (input === '/save') {
            const sessionFile = recorder.toSessionFile();
            const outputDir = join(process.cwd(), '.jam', 'sessions');
            mkdirSync(outputDir, { recursive: true });
            const path = join(outputDir, `${sessionFile.metadata.name}.jam-session.json`);
            writeFileSync(path, JSON.stringify(sessionFile, null, 2));
            process.stderr.write(`Saved: ${path}\n`);
            rl.prompt();
            return;
          }
        }

        // Standard slash commands
        if (input.startsWith('/')) {
          const result = await session.handleSlashCommand(input);
          if (result === 'exit') {
            rl.close();
            resolve();
            return;
          }
          if (result === 'unknown') {
            process.stderr.write(`Unknown: ${input}. Try /help.\n`);
          }
          rl.prompt();
          return;
        }

        // Natural language command → AI
        try {
          const result = await session.processCommand(input);
          await renderMarkdown(result.response);

          // Record tool calls if recording
          if (recorder) {
            for (const tc of result.toolCalls) {
              recorder.record(tc.name, tc.args, session.getCurrentUrl());
            }
          }
        } catch (err) {
          const jamErr = JamError.fromUnknown(err);
          await printError(jamErr.message, jamErr.hint);
        }

        rl.prompt();
      })();
    });

    rl.on('close', () => resolve());
  });
}
