export type Ownership = 'agent' | 'user-during-session' | 'pre-existing';
export type RiskLevel = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';

export type TerminalState =
  | 'COMPLETED_VERIFIED' | 'COMPLETED_PARTIAL' | 'COMPLETED_UNVERIFIED'
  | 'FAILED' | 'CANCELLED';

export interface Requirement {
  command?: string;
  mustExit?: number;
  gitDiffCheck?: boolean;
}

export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface TokenUsage { promptTokens: number; completionTokens: number; totalTokens: number }

export interface ToolResultSummary {
  ok: boolean;
  errorType?: string;
  preview: string;          // head/tail/error lines only
  artifactDigest?: string;  // full output lives in the artifact store
}

export type PolicyDecision =
  | { type: 'allow' }
  | { type: 'approval_required'; reason: string }
  | { type: 'deny'; reason: string };

export interface VerificationResult {
  requirement: string;
  exitCode: number;
  passed: boolean;
  durationMs: number;
  outputDigest: string;
  artifactDigest: string;
}

export type RuntimeEvent =
  | { type: 'session.created'; task: string; cwd: string; requirements: Requirement[] }
  | { type: 'user.message'; content: string }
  | { type: 'model.requested'; provider: string; model: string; inputTokens: number }
  | { type: 'model.completed'; content: string | null; toolCalls: ToolCall[]; usage: TokenUsage }
  | { type: 'model.failed'; error: { type: string; recoverable: boolean; message: string } }
  | { type: 'tool.requested'; callId: string; tool: string; input: unknown; risk: RiskLevel }
  | { type: 'tool.decided'; callId: string; decision: PolicyDecision }
  | { type: 'tool.completed'; callId: string; result: ToolResultSummary; durationMs: number }
  | { type: 'file.modified'; path: string; ownership: Ownership; checkpointId: string }
  | { type: 'checkpoint.created'; checkpointId: string; ref: string }
  | { type: 'verification.completed'; results: VerificationResult[] }
  | { type: 'session.terminal'; state: TerminalState };

export interface JournalEvent {
  id: string;
  sessionId: string;
  parentEventId?: string;
  logicalClock: bigint;
  at: number;
  event: RuntimeEvent;
}
