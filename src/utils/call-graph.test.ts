import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  findDefinition,
  findReferences,
  extractOutgoingCalls,
  buildCallGraph,
  formatAsciiTree,
  formatMermaid,
  formatGraphForAI,
} from './call-graph.js';

// ── Test workspace setup ─────────────────────────────────────────────────────

let workspace: string;

const FILE_A = `
import { helper } from './utils.js';
import { Logger } from './logger.js';

export async function processData(input: string, options?: { verbose: boolean }): Promise<string> {
  const log = new Logger();
  log.info('Processing...');
  const cleaned = sanitize(input);
  const result = await helper(cleaned);
  return result;
}

function sanitize(text: string): string {
  return text.trim().toLowerCase();
}

export const MAX_SIZE = 1024;
`.trim();

const FILE_B = `
import { processData } from './processor.js';

export async function handleRequest(req: Request): Promise<Response> {
  const body = await req.text();
  const result = await processData(body, { verbose: true });
  return new Response(result);
}

export function runBatch(items: string[]): void {
  for (const item of items) {
    processData(item);
  }
}
`.trim();

const FILE_C = `
export function helper(input: string): string {
  return input.toUpperCase();
}

export class Logger {
  info(msg: string): void {
    console.log(msg);
  }
}
`.trim();

const FILE_D = `
import { handleRequest } from './handler.js';

export function startServer(port: number): void {
  handleRequest(new Request('http://localhost'));
}
`.trim();

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'jam-trace-test-'));
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'src', 'processor.ts'), FILE_A);
  await writeFile(join(workspace, 'src', 'handler.ts'), FILE_B);
  await writeFile(join(workspace, 'src', 'utils.ts'), FILE_C);
  await writeFile(join(workspace, 'src', 'server.ts'), FILE_D);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

// ── findDefinition ───────────────────────────────────────────────────────────

describe('findDefinition', () => {
  it('finds an exported async function', async () => {
    const def = await findDefinition('processData', workspace);
    expect(def).not.toBeNull();
    expect(def!.name).toBe('processData');
    expect(def!.kind).toBe('function');
    expect(def!.file).toBe('src/processor.ts');
    expect(def!.params).toContain('input: string');
    expect(def!.returnType).toContain('Promise<string>');
  });

  it('finds a non-exported function', async () => {
    const def = await findDefinition('sanitize', workspace);
    expect(def).not.toBeNull();
    expect(def!.kind).toBe('function');
  });

  it('finds an exported const', async () => {
    const def = await findDefinition('MAX_SIZE', workspace);
    expect(def).not.toBeNull();
    expect(def!.kind).toBe('const');
  });

  it('finds a class', async () => {
    const def = await findDefinition('Logger', workspace);
    expect(def).not.toBeNull();
    expect(def!.kind).toBe('class');
    expect(def!.file).toBe('src/utils.ts');
  });

  it('returns null for nonexistent symbol', async () => {
    const def = await findDefinition('doesNotExist', workspace);
    expect(def).toBeNull();
  });
});

// ── findReferences ───────────────────────────────────────────────────────────

describe('findReferences', () => {
  it('finds call sites for processData', async () => {
    const { callers, imports } = await findReferences('processData', 'src/processor.ts', workspace);

    // handler.ts imports and calls processData
    expect(imports.length).toBeGreaterThanOrEqual(1);
    expect(imports.some((i) => i.file === 'src/handler.ts')).toBe(true);

    expect(callers.length).toBeGreaterThanOrEqual(2);
    expect(callers.some((c) => c.file === 'src/handler.ts' && c.args.includes('body'))).toBe(true);
  });

  it('finds import references for handleRequest', async () => {
    const { imports } = await findReferences('handleRequest', 'src/handler.ts', workspace);
    expect(imports.some((i) => i.file === 'src/server.ts')).toBe(true);
  });
});

// ── extractOutgoingCalls ─────────────────────────────────────────────────────

describe('extractOutgoingCalls', () => {
  it('extracts calls from function body', () => {
    const body = `{
  const log = new Logger();
  log.info('Processing...');
  const cleaned = sanitize(input);
  const result = await helper(cleaned);
  return result;
}`;
    const known = new Set(['sanitize', 'helper', 'Logger']);
    const calls = extractOutgoingCalls(body, 'processData', known);

    const names = calls.map((c) => c.name);
    expect(names).toContain('Logger');
    expect(names).toContain('sanitize');
    expect(names).toContain('helper');
  });

  it('filters out builtins and the symbol itself', () => {
    const body = `{
  if (true) {}
  console.log('x');
  return processData(input);
}`;
    const calls = extractOutgoingCalls(body, 'processData', new Set());
    const names = calls.map((c) => c.name);
    expect(names).not.toContain('processData');
    expect(names).not.toContain('console');
  });
});

// ── buildCallGraph ───────────────────────────────────────────────────────────

describe('buildCallGraph', () => {
  it('builds a complete graph for processData', async () => {
    const graph = await buildCallGraph('processData', workspace, { depth: 2 });

    expect(graph.symbol.name).toBe('processData');
    expect(graph.symbol.file).toBe('src/processor.ts');
    expect(graph.callers.length).toBeGreaterThanOrEqual(2);
    expect(graph.imports.length).toBeGreaterThanOrEqual(1);
    expect(graph.callees.length).toBeGreaterThanOrEqual(1);
  });

  it('returns not-found marker for missing symbol', async () => {
    const graph = await buildCallGraph('nope', workspace);
    expect(graph.symbol.file).toBe('(not found)');
    expect(graph.callers).toHaveLength(0);
  });
});

// ── Formatters ───────────────────────────────────────────────────────────────

describe('formatAsciiTree', () => {
  it('produces readable output', async () => {
    const graph = await buildCallGraph('processData', workspace, { depth: 1 });
    const tree = formatAsciiTree(graph);

    expect(tree).toContain('processData');
    expect(tree).toContain('Defined:');
    expect(tree).toContain('src/processor.ts');
  });
});

describe('formatMermaid', () => {
  it('produces valid Mermaid diagram', async () => {
    const graph = await buildCallGraph('processData', workspace, { depth: 1 });
    const mermaid = formatMermaid(graph);

    expect(mermaid).toContain('graph TD');
    expect(mermaid).toContain('processData');
    expect(mermaid).toContain('-->');
    expect(mermaid).toContain('style');
  });
});

describe('formatGraphForAI', () => {
  it('produces markdown context', async () => {
    const graph = await buildCallGraph('processData', workspace, { depth: 1 });
    const context = formatGraphForAI(graph);

    expect(context).toContain('# Call Graph: processData');
    expect(context).toContain('## Call Sites');
    // Outgoing calls section appears if the body has recognized calls
    expect(context).toMatch(/## (Outgoing Calls|Source Body)/);
  });
});
