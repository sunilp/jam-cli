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
});
