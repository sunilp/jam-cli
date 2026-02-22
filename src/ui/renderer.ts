import { marked } from 'marked';
import type { ChalkInstance } from 'chalk';
import type { StreamChunk } from '../providers/base.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let terminalRenderer: any = null;
let chalkInstance: ChalkInstance | null = null;

async function getChalk(): Promise<ChalkInstance> {
  if (!chalkInstance) {
    const mod = await import('chalk');
    chalkInstance = mod.default;
  }
  return chalkInstance;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getTerminalRenderer(): Promise<any> {
  if (!terminalRenderer) {
    const { default: TerminalRenderer } = await import('marked-terminal');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    terminalRenderer = new TerminalRenderer();
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return terminalRenderer;
}

export async function renderMarkdown(text: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const renderer = await getTerminalRenderer();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument
  marked.use({ renderer });
  return marked(text) as string;
}

export async function streamToStdout(
  stream: AsyncIterable<StreamChunk>
): Promise<{ text: string; usage?: StreamChunk['usage'] }> {
  let text = '';
  let usage: StreamChunk['usage'];

  for await (const chunk of stream) {
    if (chunk.done) {
      usage = chunk.usage;
      continue;
    }
    text += chunk.delta;
    process.stdout.write(chunk.delta);
  }

  // End with newline if content doesn't end with one
  if (text && !text.endsWith('\n')) {
    process.stdout.write('\n');
  }

  return { text, usage };
}

export function printJsonResult(result: {
  response: string;
  usage?: StreamChunk['usage'];
  model?: string;
}): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

export async function printError(message: string): Promise<void> {
  const ck = await getChalk();
  process.stderr.write(ck.red(`Error: ${message}`) + '\n');
}

export async function printWarning(message: string): Promise<void> {
  const ck = await getChalk();
  process.stderr.write(ck.yellow(`Warning: ${message}`) + '\n');
}

export async function printSuccess(message: string): Promise<void> {
  const ck = await getChalk();
  process.stderr.write(ck.green(message) + '\n');
}
