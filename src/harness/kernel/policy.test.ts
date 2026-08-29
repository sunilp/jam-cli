import { describe, it, expect } from 'vitest';
import { combine, DefaultPolicy } from './policy.js';

describe('combine', () => {
  const allow = { type: 'allow' } as const;
  const ask = { type: 'approval_required', reason: 'r' } as const;
  const deny = { type: 'deny', reason: 'r' } as const;

  it('is restrictive and order-independent', () => {
    expect(combine(allow, deny).type).toBe('deny');
    expect(combine(deny, allow).type).toBe('deny');
    expect(combine(ask, deny).type).toBe('deny');
    expect(combine(deny, ask).type).toBe('deny');
    expect(combine(allow, ask).type).toBe('approval_required');
    expect(combine(ask, allow).type).toBe('approval_required');
    expect(combine(allow, allow).type).toBe('allow');
  });

  it('cannot be walked back to allow by any later decision', () => {
    let d = combine(allow, deny);
    for (const later of [allow, ask, allow, allow]) d = combine(d, later);
    expect(d.type).toBe('deny');
  });
});

describe('DefaultPolicy', () => {
  const p = new DefaultPolicy();
  const base = { tool: 'read_file', input: {}, provenance: 'model' as const, workspaceRoot: '/w' };

  it('allows R0 and R1, asks on R2 and R3, denies R4', () => {
    expect(p.evaluate({ ...base, risk: 'R0' }).type).toBe('allow');
    expect(p.evaluate({ ...base, risk: 'R1' }).type).toBe('allow');
    expect(p.evaluate({ ...base, risk: 'R2' }).type).toBe('approval_required');
    expect(p.evaluate({ ...base, risk: 'R3' }).type).toBe('approval_required');
    expect(p.evaluate({ ...base, risk: 'R4' }).type).toBe('deny');
  });

  it('pre-authorizes declared verification commands', () => {
    expect(p.evaluate({ ...base, tool: 'run_command', risk: 'R2', provenance: 'declared' }).type)
      .toBe('allow');
  });

  it('denies any mutation under .jam/, whatever the risk', () => {
    // Without this a model that cannot pass npm test deletes the requirement.
    const d = p.evaluate({
      ...base, tool: 'apply_patch', risk: 'R1',
      input: { patch: '--- a/.jam/config.yaml\n+++ b/.jam/config.yaml\n' },
    });
    expect(d.type).toBe('deny');
  });

  it('denies apply_patch touching .jam even when other files are included', () => {
    const d = p.evaluate({
      ...base, tool: 'apply_patch', risk: 'R1',
      input: { patch: '--- a/src/x.ts\n+++ b/src/x.ts\n--- a/.jam/config.yaml\n' },
    });
    expect(d.type).toBe('deny');
  });

  it('denies shell access to .jam/, which is otherwise a way around the guard', () => {
    for (const args of [
      ['-c', 'echo "verification: {}" > .jam/config.yaml'],
      ['-c', 'rm ./.jam/config.yaml'],
      ['-c', 'cat a/../.jam/config.yaml > /dev/null'],
      ['/w/.jam/config.yaml'],
      ['.jam\\config.yaml'],
      ['-rf', '.jam'],
    ]) {
      const d = p.evaluate({
        ...base, tool: 'run_command', risk: 'R2', input: { command: 'sh', args },
      });
      expect(d, `args ${JSON.stringify(args)}`).toMatchObject({ type: 'deny' });
    }
  });

  it('denies case variants, since the filesystem is case-insensitive', () => {
    for (const variant of ['.JAM', '.Jam', '.jAm']) {
      const patched = p.evaluate({
        ...base, tool: 'apply_patch', risk: 'R1',
        input: { patch: `--- a/${variant}/config.yaml\n+++ b/${variant}/config.yaml\n` },
      });
      expect(patched, variant).toMatchObject({ type: 'deny' });

      const shelled = p.evaluate({
        ...base, tool: 'run_command', risk: 'R2',
        input: { command: 'sh', args: ['-c', `echo bad > ${variant}/config.yaml`] },
      });
      expect(shelled, variant).toMatchObject({ type: 'deny' });
    }
  });

  it('does not deny paths that merely start with the same letters', () => {
    const d = p.evaluate({
      ...base, tool: 'run_command', risk: 'R1',
      input: { command: 'cat', args: ['.jamfile', 'src/myjam/x.ts'] },
    });
    expect(d.type).not.toBe('deny');
  });

  it('still allows reading .jam through the non-mutating read_file tool', () => {
    const d = p.evaluate({
      ...base, tool: 'read_file', risk: 'R0', input: { path: '.jam/config.yaml' },
    });
    expect(d.type).toBe('allow');
  });

  it('escalates a shell command that reaches outside the workspace', () => {
    for (const args of [['/etc/passwd'], ['../../secrets.txt'], ['/tmp/elsewhere/x']]) {
      const d = p.evaluate({
        ...base, tool: 'run_command', risk: 'R0',
        input: { command: 'cat', args }, workspaceRoot: '/w',
      });
      expect(d, JSON.stringify(args)).toMatchObject({ type: 'approval_required' });
    }
  });

  it('leaves ordinary in-workspace commands alone', () => {
    for (const args of [['test'], ['run', 'build'], ['src/index.ts']]) {
      const d = p.evaluate({
        ...base, tool: 'run_command', risk: 'R1',
        input: { command: 'npm', args }, workspaceRoot: '/w',
      });
      expect(d, JSON.stringify(args)).toMatchObject({ type: 'allow' });
    }
  });

  it('does not prompt for a relative path that never leaves the workspace', () => {
    const d = p.evaluate({
      ...base, tool: 'run_command', risk: 'R1',
      input: { command: 'cat', args: ['src/../src/index.ts'] }, workspaceRoot: '/w',
    });
    expect(d.type).toBe('allow');
  });

  it('allows a benign apply_patch whose diff body contains a deep relative ' +
     'import, rather than treating the whole patch blob as one path', () => {
    // stringsIn returns the entire patch as a single string; before this fix,
    // resolve(root, wholePatch) split that blob on '/' and any deep relative
    // reference inside an ordinary diff line (not a file header) tripped the
    // workspace-escape check, over-triggering approval_required on a normal
    // patch — which applyFailClosed turns into a hard deny in CI.
    const d = p.evaluate({
      ...base, tool: 'apply_patch', risk: 'R1',
      input: { patch:
        '--- a/src/x.ts\n+++ b/src/x.ts\n' +
        "@@ -1,2 +1,2 @@\n-import a from '../../old';\n+import a from '../../../src/x';\n",
      },
    });
    expect(d.type).toBe('allow');
  });

  it('still denies .jam/ inside an apply_patch diff, unaffected by the ' +
     'workspace-escape scoping change', () => {
    const d = p.evaluate({
      ...base, tool: 'apply_patch', risk: 'R1',
      input: { patch: '--- a/.jam/config.yaml\n+++ b/.jam/config.yaml\n' },
    });
    expect(d.type).toBe('deny');
  });

  it('treats a Windows drive-letter path as outside a posix workspace', () => {
    const d = p.evaluate({
      ...base, tool: 'run_command', risk: 'R0',
      input: { command: 'cat', args: ['C:\\Users\\x\\secret.txt'] }, workspaceRoot: '/w',
    });
    expect(d.type).toBe('approval_required');
  });
});
