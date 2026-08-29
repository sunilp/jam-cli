import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from './registry.js';
import type { Tool } from './types.js';

const noop: Tool<{ a: string }, string> = {
  name: 'noop',
  description: 'does nothing',
  input: z.object({ a: z.string() }),
  risk: 'R0',
  mutates: false,
  execute: (i) => Promise.resolve({ ok: true, value: i.a }),
};

describe('ToolRegistry', () => {
  it('registers and retrieves', () => {
    const r = new ToolRegistry();
    r.register(noop);
    expect(r.get('noop')?.name).toBe('noop');
  });

  it('unregisters via the returned disposable', () => {
    const r = new ToolRegistry();
    const d = r.register(noop);
    d.dispose();
    expect(r.get('noop')).toBeUndefined();
  });

  it('rejects duplicate names', () => {
    const r = new ToolRegistry();
    r.register(noop);
    expect(() => r.register(noop)).toThrow(/already registered/);
  });

  it('generates a JSON schema for the provider from the zod type', () => {
    const r = new ToolRegistry();
    r.register(noop);
    const [def] = r.definitions();
    expect(def).toMatchObject({
      name: 'noop',
      parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
    });
  });

  it('derives each field type from zod rather than guessing', () => {
    const shapes: Tool<Record<string, unknown>, null> = {
      name: 'shapes',
      description: 'many field kinds',
      input: z.object({
        s: z.string().describe('a string'),
        n: z.number(),
        b: z.boolean(),
        arr: z.array(z.string()),
        e: z.enum(['x', 'y']),
        opt: z.string().optional(),
      }),
      risk: 'R0',
      mutates: false,
      execute: () => Promise.resolve({ ok: true, value: null }),
    };
    const r = new ToolRegistry();
    r.register(shapes);
    const [def] = r.definitions();

    expect(def!.parameters.properties).toMatchObject({
      s: { type: 'string', description: 'a string' },
      n: { type: 'number' },
      b: { type: 'boolean' },
      arr: { type: 'array', items: { type: 'string' } },
      e: { type: 'string', enum: ['x', 'y'] },
      opt: { type: 'string' },
    });
    expect(def!.parameters.required).toEqual(['s', 'n', 'b', 'arr', 'e']);
  });

  it('refuses to emit a schema for a zod shape it does not model', () => {
    const nested: Tool<Record<string, unknown>, null> = {
      name: 'nested',
      description: 'unsupported shape',
      input: z.object({ o: z.object({ x: z.string() }) }),
      risk: 'R0',
      mutates: false,
      execute: () => Promise.resolve({ ok: true, value: null }),
    };
    const r = new ToolRegistry();
    r.register(nested);
    expect(() => r.definitions()).toThrow(/does not model/);
  });
});
