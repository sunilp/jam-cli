import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { PolicyDecision, RiskLevel } from '../events.js';

export interface ApprovalRequest {
  callId: string;
  tool: string;
  risk: RiskLevel;
  reason: string;
  summary: string;
}

/**
 * Shaped after ACP's agent-to-client session/request_permission so the ACP
 * adapter in sub-project 4 needs no change to the loop.
 */
export interface ApprovalHost {
  available(): boolean;
  request(req: ApprovalRequest, signal: AbortSignal): Promise<boolean>;
}

/** ASK with nobody to ask is DENY. Never proceed. */
export function applyFailClosed(d: PolicyDecision, host: ApprovalHost): PolicyDecision {
  if (d.type === 'approval_required' && !host.available()) {
    return { type: 'deny', reason: 'approval required, no approver available' };
  }
  return d;
}

export class TerminalApprovalHost implements ApprovalHost {
  available(): boolean { return stdin.isTTY === true; }

  async request(req: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const onAbort = (): void => rl.close();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      stdout.write(`\n  ${req.tool} [${req.risk}] — ${req.reason}\n  ${req.summary}\n`);
      const answer = await rl.question('  allow? [y/N] ');
      return answer.trim().toLowerCase() === 'y';
    } catch {
      return false;
    } finally {
      signal.removeEventListener('abort', onAbort);
      rl.close();
    }
  }
}

export class AutoDenyApprovalHost implements ApprovalHost {
  available(): boolean { return false; }
  request(): Promise<boolean> { return Promise.resolve(false); }
}

/** Test double. Never use outside tests. */
export class AutoApproveApprovalHost implements ApprovalHost {
  available(): boolean { return true; }
  request(): Promise<boolean> { return Promise.resolve(true); }
}
