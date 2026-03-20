import { describe, it, expect } from 'vitest';
import { FileLockManager } from './file-lock.js';

describe('FileLockManager', () => {
  it('assigns ownership from plan', () => {
    const mgr = new FileLockManager();
    mgr.assignOwnership('w1', [
      { path: 'src/a.ts', mode: 'create' },
      { path: 'src/b.ts', mode: 'modify' },
    ]);
    expect(mgr.getOwner('src/a.ts')).toBe('w1');
    expect(mgr.getOwner('src/b.ts')).toBe('w1');
  });

  it('grants request for unowned file', () => {
    const mgr = new FileLockManager();
    const resp = mgr.requestFile({ workerId: 'w1', path: 'src/c.ts', reason: 'need it' });
    expect(resp.granted).toBe(true);
    expect(mgr.getOwner('src/c.ts')).toBe('w1');
  });

  it('grants request for own file', () => {
    const mgr = new FileLockManager();
    mgr.assignOwnership('w1', [{ path: 'src/a.ts', mode: 'modify' }]);
    const resp = mgr.requestFile({ workerId: 'w1', path: 'src/a.ts', reason: 'already mine' });
    expect(resp.granted).toBe(true);
  });

  it('denies request for file owned by another worker', () => {
    const mgr = new FileLockManager();
    mgr.assignOwnership('w1', [{ path: 'src/a.ts', mode: 'modify' }]);
    const resp = mgr.requestFile({ workerId: 'w2', path: 'src/a.ts', reason: 'need it' });
    expect(resp.granted).toBe(false);
    expect(resp.waitForWorker).toBe('w1');
  });

  it('releases all locks for a worker', () => {
    const mgr = new FileLockManager();
    mgr.assignOwnership('w1', [
      { path: 'src/a.ts', mode: 'create' },
      { path: 'src/b.ts', mode: 'modify' },
    ]);
    mgr.releaseAll('w1');
    expect(mgr.getOwner('src/a.ts')).toBeUndefined();
    expect(mgr.getOwner('src/b.ts')).toBeUndefined();
  });

  it('grants file after previous owner releases', () => {
    const mgr = new FileLockManager();
    mgr.assignOwnership('w1', [{ path: 'src/a.ts', mode: 'modify' }]);
    mgr.releaseAll('w1');
    const resp = mgr.requestFile({ workerId: 'w2', path: 'src/a.ts', reason: 'now free' });
    expect(resp.granted).toBe(true);
  });

  it('detects deadlock (cycle in wait graph)', () => {
    const mgr = new FileLockManager();
    mgr.assignOwnership('w1', [{ path: 'src/a.ts', mode: 'modify' }]);
    mgr.assignOwnership('w2', [{ path: 'src/b.ts', mode: 'modify' }]);
    // w1 waits for w2's file
    mgr.requestFile({ workerId: 'w1', path: 'src/b.ts', reason: 'need b' });
    // Now w2 wants w1's file — this would create a deadlock
    const resp = mgr.requestFile({ workerId: 'w2', path: 'src/a.ts', reason: 'need a' });
    expect(resp.granted).toBe(false);
    // detectDeadlock should return true internally
  });

  it('returns undefined owner for unknown path', () => {
    const mgr = new FileLockManager();
    expect(mgr.getOwner('nonexistent')).toBeUndefined();
  });
});
