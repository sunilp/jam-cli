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

const MUTATING_TOOLS = new Set(['apply_patch', 'write_file']);
const PROTECTED_PATH = /(^|[\s"'/])\.jam\//;

export class DefaultPolicy implements PolicyEngine {
  evaluate(input: PolicyInput): PolicyDecision {
    // Requirements and the config that declares them are off limits to the
    // model. See spec 9.3 — without this, completion can be faked.
    if (MUTATING_TOOLS.has(input.tool) && this.touchesProtectedPath(input.input)) {
      return { type: 'deny', reason: 'mutation of .jam/ is not permitted' };
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

  private touchesProtectedPath(input: unknown): boolean {
    if (typeof input !== 'object' || input === null) return false;
    const values = Object.values(input as Record<string, unknown>);
    return values.some((v) => typeof v === 'string' && PROTECTED_PATH.test(v));
  }
}
