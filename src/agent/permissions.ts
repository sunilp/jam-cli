import type { PermissionTier } from './types.js';

// ── Regex patterns for classification ────────────────────────────────────────

const SAFE_PATTERNS: RegExp[] = [
  // File inspection
  /^ls(\s|$)/,
  /^cat(\s|$)/,
  /^head(\s|$)/,
  /^tail(\s|$)/,
  /^wc(\s|$)/,
  /^echo(\s|$)/,
  /^pwd(\s|$)/,
  /^whoami(\s|$)/,
  /^date(\s|$)/,
  /^which(\s|$)/,
  /^env(\s|$)/,
  /^find(\s|$)/,
  /^grep(\s|$)/,
  /^rg(\s|$)/,
  /^fd(\s|$)/,
  // Git read-only
  /^git\s+status(\s|$)/,
  /^git\s+diff(\s|$)/,
  /^git\s+log(\s|$)/,
  /^git\s+show(\s|$)/,
  /^git\s+branch(\s|$)/,
  /^git\s+tag(\s|$)/,
  /^git\s+remote(\s|$)/,
  /^git\s+rev-parse(\s|$)/,
  // Test runners
  /^npm\s+test(\s|$)/,
  /^npx\s+vitest(\s|$)/,
  /^npx\s+jest(\s|$)/,
  /^npx\s+tsc(\s|$)/,
  /^npx\s+eslint(\s|$)/,
  /^npx\s+prettier(\s|$)/,
  // Runtimes (read/run only)
  /^node(\s|$)/,
  /^deno(\s|$)/,
  /^bun\s+test(\s|$)/,
  /^bun\s+run(\s|$)/,
  /^cargo\s+test(\s|$)/,
  /^go\s+test(\s|$)/,
  /^python\s+-m\s+pytest(\s|$)/,
];

const DANGEROUS_PATTERNS: RegExp[] = [
  // Destructive rm
  /\brm\b.*-[a-zA-Z]*[rf][a-zA-Z]*/,
  /\brm\b.*--recursive/,
  /\brm\b.*--force/,
  // Dangerous git
  /^git\s+push(\s|$)/,
  /^git\s+reset(\s|$)/,
  /^git\s+rebase(\s|$)/,
  /^git\s+push\s+.*--force/,
  /^git\s+checkout\s+--(\s|$)/,
  /^git\s+branch\s+(-d|-D)(\s|$)/,
  // Permission changes
  /^chmod(\s|$)/,
  /^chown(\s|$)/,
  // Privilege escalation
  /^sudo(\s|$)/,
  /^su\s+-(\s|$)/,
  /^su\s*$/,
  // Piped commands
  /\|/,
];

// ── Hard-block patterns (unoverridable safety floor) ─────────────────────────

const HARD_BLOCK_PATTERNS: RegExp[] = [
  /\brm\b.*-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s*\//, // rm -rf /
  /\brm\b.*-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s*\//, // rm -fr /
  /^sudo(\s|$)/,
  /^su\s+-(\s|$)/,
  /^su\s*$/,
  /^mkfs(\s|$)/,
  /^dd(\s|$)/,
  /^chmod\s+777\s+\//,
  /^shutdown(\s|$)/,
  /^reboot(\s|$)/,
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether a command is unconditionally blocked regardless of user config.
 */
export function isHardBlocked(command: string): boolean {
  const trimmed = command.trim();
  return HARD_BLOCK_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Classify a shell command into safe / moderate / dangerous using default patterns.
 */
export function classifyCommand(command: string): PermissionTier {
  const trimmed = command.trim();

  if (DANGEROUS_PATTERNS.some((p) => p.test(trimmed))) return 'dangerous';
  if (SAFE_PATTERNS.some((p) => p.test(trimmed))) return 'safe';
  return 'moderate';
}

/**
 * Permission classifier with custom per-session overrides.
 * Override lists use string startsWith matching and take precedence over
 * the default patterns, but hard-blocks always win.
 */
export class PermissionClassifier {
  private safeOverrides: string[];
  private dangerousOverrides: string[];

  constructor(overrides: { safe: string[]; dangerous: string[] }) {
    this.safeOverrides = overrides.safe;
    this.dangerousOverrides = overrides.dangerous;
  }

  classify(command: string): PermissionTier | 'blocked' {
    const trimmed = command.trim();

    // Hard-block check first — cannot be overridden
    if (isHardBlocked(trimmed)) return 'blocked';

    // Custom dangerous overrides
    if (this.dangerousOverrides.some((prefix) => trimmed.startsWith(prefix))) {
      return 'dangerous';
    }

    // Custom safe overrides
    if (this.safeOverrides.some((prefix) => trimmed.startsWith(prefix))) {
      return 'safe';
    }

    // Fall back to default classifier
    return classifyCommand(trimmed);
  }
}

/**
 * Tracks session-level approvals for "confirm once per type" in auto mode.
 * Command type is the first 2 words (e.g. "git push origin main" → "git push").
 */
export class ApprovalTracker {
  private approved = new Set<string>();

  private normalize(command: string): string {
    return command.trim().split(/\s+/).slice(0, 2).join(' ');
  }

  isApproved(command: string): boolean {
    return this.approved.has(this.normalize(command));
  }

  approve(command: string): void {
    this.approved.add(this.normalize(command));
  }
}
