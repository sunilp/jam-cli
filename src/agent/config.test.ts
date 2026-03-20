import { describe, it, expect } from 'vitest';
import { JamConfigSchema } from '../config/schema.js';

describe('agent config schema', () => {
  it('provides defaults when agent section is omitted', () => {
    const result = JamConfigSchema.parse({});
    expect(result.agent).toBeDefined();
    expect(result.agent.maxWorkers).toBe(3);
    expect(result.agent.defaultMode).toBe('supervised');
    expect(result.agent.maxRoundsPerWorker).toBe(20);
    expect(result.agent.sandbox.filesystem).toBe('workspace-only');
    expect(result.agent.sandbox.network).toBe('allowed');
    expect(result.agent.sandbox.timeout).toBe(60000);
    expect(result.agent.permissions.safe).toEqual([]);
    expect(result.agent.permissions.dangerous).toEqual([]);
  });

  it('validates custom agent config', () => {
    const result = JamConfigSchema.parse({
      agent: {
        maxWorkers: 5,
        defaultMode: 'auto',
        permissions: { safe: ['npm test'], dangerous: ['docker rm'] },
        sandbox: { filesystem: 'unrestricted', network: 'blocked', timeout: 30000 },
      },
    });
    expect(result.agent.maxWorkers).toBe(5);
    expect(result.agent.defaultMode).toBe('auto');
    expect(result.agent.permissions.safe).toEqual(['npm test']);
    expect(result.agent.sandbox.network).toBe('blocked');
  });

  it('rejects invalid mode', () => {
    expect(() => JamConfigSchema.parse({ agent: { defaultMode: 'yolo' } })).toThrow();
  });

  it('rejects maxWorkers < 1', () => {
    expect(() => JamConfigSchema.parse({ agent: { maxWorkers: 0 } })).toThrow();
  });

  it('rejects maxRoundsPerWorker out of bounds', () => {
    expect(() => JamConfigSchema.parse({ agent: { maxRoundsPerWorker: 0 } })).toThrow();
    expect(() => JamConfigSchema.parse({ agent: { maxRoundsPerWorker: 51 } })).toThrow();
  });
});
