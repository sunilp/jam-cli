import { describe, it, expect } from 'vitest';
import { AutoDenyApprovalHost, applyFailClosed } from './approval.js';

describe('fail closed', () => {
  it('turns approval_required into deny when no approver is available', () => {
    const host = new AutoDenyApprovalHost();
    const d = applyFailClosed({ type: 'approval_required', reason: 'risky' }, host);
    expect(d.type).toBe('deny');
    expect((d as { reason: string }).reason).toMatch(/no approver/i);
  });

  it('leaves allow untouched', () => {
    expect(applyFailClosed({ type: 'allow' }, new AutoDenyApprovalHost()).type).toBe('allow');
  });
});
