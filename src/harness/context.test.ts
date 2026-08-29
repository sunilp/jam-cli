import { describe, it, expect } from 'vitest';
import { NaiveContext, SYSTEM_PROMPT } from './context.js';
import { Journal } from './journal.js';
import { ToolRegistry } from './tools/registry.js';

describe('NaiveContext', () => {
  it('opens with the system prompt and the task', () => {
    const j = new Journal(':memory:');
    const s = j.createSession({ task: 'fix the tests', cwd: '/w', requirements: [] });
    const ctx = new NaiveContext(j, new ToolRegistry()).build(s);

    expect(ctx.messages[0]).toMatchObject({ role: 'system', content: SYSTEM_PROMPT });
    expect(ctx.messages[1]).toMatchObject({ role: 'user', content: 'fix the tests' });
    j.close();
  });

  it('renders tool results as tool messages the model can act on', () => {
    const j = new Journal(':memory:');
    const s = j.createSession({ task: 't', cwd: '/w', requirements: [] });
    j.append(s, {
      type: 'tool.completed', callId: 'c1',
      result: { ok: false, errorType: 'patch.conflict', preview: 'does not apply' },
      durationMs: 5,
    });
    const ctx = new NaiveContext(j, new ToolRegistry()).build(s);
    const last = ctx.messages.at(-1)!;
    expect(last.role).toBe('tool');
    expect(last.content).toContain('patch.conflict');
    j.close();
  });

  it('marks repository content as untrusted so injected text has no authority', () => {
    expect(SYSTEM_PROMPT).toContain('untrusted');
  });

  it('drops the oldest turns when over budget but always keeps the system prompt and task', () => {
    const j = new Journal(':memory:');
    const s = j.createSession({ task: 'keep me', cwd: '/w', requirements: [] });
    for (let i = 0; i < 400; i++) {
      j.append(s, { type: 'user.message', content: `filler ${i} `.repeat(50) });
    }
    const ctx = new NaiveContext(j, new ToolRegistry(), { maxChars: 4000 }).build(s);
    expect(ctx.messages[0]!.role).toBe('system');
    expect(ctx.messages[1]!.content).toBe('keep me');
    const size = ctx.messages.reduce((n, m) => n + m.content.length, 0);
    expect(size).toBeLessThanOrEqual(4000 + SYSTEM_PROMPT.length);
    j.close();
  });
});
