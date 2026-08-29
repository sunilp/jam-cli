import { resolve, sep } from 'node:path';
import type { PolicyDecision, RiskLevel } from '../events.js';

export type Provenance = 'model' | 'declared' | 'user';

export interface PolicyInput {
  tool: string;
  input: unknown;
  risk: RiskLevel;
  provenance: Provenance;
  workspaceRoot: string;
}

export interface PolicyEngine {
  evaluate(input: PolicyInput): PolicyDecision;
}

const RANK: Record<PolicyDecision['type'], number> = {
  allow: 0, approval_required: 1, deny: 2,
};

/** Monotonic: deny > approval_required > allow. Nothing can weaken a decision. */
export function combine(a: PolicyDecision, b: PolicyDecision): PolicyDecision {
  return RANK[a.type] >= RANK[b.type] ? a : b;
}

// run_command belongs here: a shell can mutate .jam/ just as effectively as a
// patch, and leaving it out downgrades the one categorical rule in the design
// to an approval prompt the model can talk its way past.
const MUTATION_CAPABLE = new Set(['apply_patch', 'write_file', 'run_command']);

/** `.jam` as a path segment, separator-normalised. Matches .jam/, ./.jam/,
 *  a/../.jam/, /abs/.jam/x, .jam\config.yaml and bare `.jam`; not `.jamfile`. */
const PROTECTED_SEGMENT = /(^|[^A-Za-z0-9_.-])\.jam($|\/|[^A-Za-z0-9_.-])/;

/** Every string anywhere in the input, including inside arrays. run_command's
 *  args is an array, so a values-only scan never sees the payload at all. */
function stringsIn(value: unknown, depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((v) => stringsIn(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap((v) => stringsIn(v, depth + 1));
  }
  return [];
}

export class DefaultPolicy implements PolicyEngine {
  evaluate(input: PolicyInput): PolicyDecision {
    // Requirements and the config that declares them are off limits to the
    // model. See spec 9.3 — without this, completion can be faked.
    if (MUTATION_CAPABLE.has(input.tool) && this.touchesProtectedPath(input.input)) {
      return { type: 'deny', reason: 'mutation of .jam/ is not permitted' };
    }

    // A shell can read or write anywhere; run_command never calls safePath, and
    // cat/head/grep are R0, so `cat /etc/passwd` was auto-allowed with no
    // prompt at all. Full confinement is the sandbox's job (sub-project 2), but
    // a path that leaves the workspace must at least reach a human first.
    if (MUTATION_CAPABLE.has(input.tool) && this.escapesWorkspace(input)) {
      return { type: 'approval_required', reason: 'references a path outside the workspace' };
    }

    // Verification commands were declared by the user, not proposed by the
    // model, so the authority hierarchy already settles them.
    if (input.provenance === 'declared') return { type: 'allow' };

    switch (input.risk) {
      case 'R0':
      case 'R1': return { type: 'allow' };
      case 'R2': return { type: 'approval_required', reason: 'workspace or network effect' };
      case 'R3': return { type: 'approval_required', reason: 'potentially destructive' };
      case 'R4': return { type: 'deny', reason: 'external or production effect' };
    }
  }

  /** Any argument that is an absolute path outside the root, or walks out via `..`. */
  private escapesWorkspace(input: PolicyInput): boolean {
    const root = resolve(input.workspaceRoot);
    return stringsIn(input.input).some((s) => {
      if (!s.includes('/') && !s.includes('\\')) return false;   // not path-shaped
      const norm = s.replace(/\\/g, '/');
      if (norm.startsWith('/')) {
        const abs = resolve(norm);
        return abs !== root && !abs.startsWith(root + sep);
      }
      return norm.split('/').includes('..');
    });
  }

  private touchesProtectedPath(input: unknown): boolean {
    // Lower-cased: macOS and Windows filesystems are case-insensitive by
    // default, so `.JAM/config.yaml` reaches the same file as `.jam/`.
    // Without this a one-character change turns a categorical deny into allow.
    return stringsIn(input).some((s) =>
      PROTECTED_SEGMENT.test(s.replace(/\\/g, '/').toLowerCase())
    );
  }
}
