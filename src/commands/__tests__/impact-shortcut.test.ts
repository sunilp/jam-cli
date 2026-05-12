import { describe, it, expect, vi } from 'vitest';

describe('impact shortcut', () => {
  it('delegates to runTrace with impact: true', async () => {
    const runTraceMock = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../trace.js', () => ({ runTrace: runTraceMock }));
    const { runImpact } = await import('../impact.js');
    await runImpact('customer.legacy_id', { depth: 5 });
    expect(runTraceMock).toHaveBeenCalledWith(
      'customer.legacy_id',
      expect.objectContaining({ impact: true, depth: 5 }),
    );
    vi.doUnmock('../trace.js');
  });
});
