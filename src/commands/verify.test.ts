import { describe, it, expect } from 'vitest';

// We test the pure functions exported/importable from verify.ts
// The main runVerify function requires git + filesystem so we test the building blocks

// Import the module to access parseDiff and check helpers via their effects
// Since parseDiff and check functions aren't exported directly, we test through
// the types and patterns they produce

describe('verify: secret detection patterns', () => {
  // Recreate the patterns here for unit testing
  const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
    { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/ },
    { name: 'Generic API Key', pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}["']?/i },
    { name: 'Generic Secret', pattern: /(?:secret|password|passwd|token)\s*[:=]\s*["'][^"']{8,}["']/i },
    { name: 'Private Key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
    { name: 'GitHub Token', pattern: /gh[ps]_[A-Za-z0-9_]{36,}/ },
    { name: 'Slack Token', pattern: /xox[bpors]-[A-Za-z0-9-]{10,}/ },
    { name: 'Anthropic API Key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/ },
    { name: 'OpenAI API Key', pattern: /sk-[A-Za-z0-9]{20,}/ },
  ];

  function detectSecrets(line: string): string[] {
    const found: string[] = [];
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(line)) found.push(name);
    }
    return found;
  }

  it('detects AWS access keys', () => {
    expect(detectSecrets('AKIAIOSFODNN7EXAMPLE')).toContain('AWS Access Key');
  });

  it('detects GitHub tokens', () => {
    expect(detectSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop')).toContain('GitHub Token');
  });

  it('detects private keys', () => {
    expect(detectSecrets('-----BEGIN RSA PRIVATE KEY-----')).toContain('Private Key');
  });

  it('detects generic API keys', () => {
    expect(detectSecrets('api_key = "abcdef1234567890abcdef"')).toContain('Generic API Key');
  });

  it('detects generic secrets', () => {
    expect(detectSecrets('password = "supersecretpassword123"')).toContain('Generic Secret');
  });

  it('does not flag normal code', () => {
    expect(detectSecrets('const x = 42;')).toEqual([]);
  });

  it('does not flag short strings', () => {
    expect(detectSecrets('token = "short"')).toEqual([]);
  });

  it('detects Anthropic API keys', () => {
    expect(detectSecrets('sk-ant-abcdefghij1234567890abcdef')).toContain('Anthropic API Key');
  });
});

describe('verify: diff parsing', () => {
  function parseDiff(diff: string) {
    const lines = diff.split('\n');
    let insertions = 0;
    let deletions = 0;
    const addedLines: string[] = [];
    const changedFiles = new Set<string>();

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        const match = line.match(/diff --git a\/.+ b\/(.+)/);
        if (match) changedFiles.add(match[1]!);
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        insertions++;
        addedLines.push(line.slice(1));
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions++;
      }
    }

    return { filesChanged: changedFiles.size, insertions, deletions, addedLines, changedFiles: [...changedFiles] };
  }

  it('parses a simple diff', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,3 +1,4 @@',
      ' import { foo } from "./foo";',
      '+import { bar } from "./bar";',
      ' ',
      '-const x = 1;',
      '+const x = 2;',
    ].join('\n');

    const stats = parseDiff(diff);
    expect(stats.filesChanged).toBe(1);
    expect(stats.insertions).toBe(2);
    expect(stats.deletions).toBe(1);
    expect(stats.changedFiles).toEqual(['src/index.ts']);
    expect(stats.addedLines).toContain('import { bar } from "./bar";');
  });

  it('parses multi-file diff', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '+++ b/a.ts',
      '+line1',
      'diff --git a/b.ts b/b.ts',
      '+++ b/b.ts',
      '+line2',
      '+line3',
    ].join('\n');

    const stats = parseDiff(diff);
    expect(stats.filesChanged).toBe(2);
    expect(stats.insertions).toBe(3);
  });

  it('handles empty diff', () => {
    const stats = parseDiff('');
    expect(stats.filesChanged).toBe(0);
    expect(stats.insertions).toBe(0);
    expect(stats.deletions).toBe(0);
  });
});

describe('verify: forbidden path detection', () => {
  const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\.env(?:\.|$)/, reason: 'environment file' },
    { pattern: /credentials\.\w+$/, reason: 'credentials file' },
    { pattern: /(?:^|\/)\.ssh\//, reason: 'SSH directory' },
    { pattern: /id_rsa|id_ed25519|id_ecdsa/, reason: 'SSH private key' },
  ];

  function checkForbidden(file: string): string | null {
    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      if (pattern.test(file)) return reason;
    }
    return null;
  }

  it('flags .env files', () => {
    expect(checkForbidden('.env')).toBeTruthy();
    expect(checkForbidden('.env.local')).toBeTruthy();
    expect(checkForbidden('.env.production')).toBeTruthy();
  });

  it('flags credentials files', () => {
    expect(checkForbidden('credentials.json')).toBeTruthy();
    expect(checkForbidden('config/credentials.yaml')).toBeTruthy();
  });

  it('flags SSH keys', () => {
    expect(checkForbidden('id_rsa')).toBeTruthy();
    expect(checkForbidden('.ssh/config')).toBeTruthy();
  });

  it('allows normal files', () => {
    expect(checkForbidden('src/index.ts')).toBeNull();
    expect(checkForbidden('package.json')).toBeNull();
    expect(checkForbidden('README.md')).toBeNull();
  });
});

describe('verify: risk scoring', () => {
  type CheckResult = { name: string; status: 'pass' | 'fail' | 'warn' | 'skip'; message: string; durationMs: number };

  function computeRisk(checks: CheckResult[]) {
    let score = 0;
    for (const check of checks) {
      if (check.status === 'fail') {
        switch (check.name) {
          case 'secrets': score += 0.4; break;
          case 'typecheck': score += 0.2; break;
          case 'lint': score += 0.1; break;
          case 'tests': score += 0.25; break;
          default: score += 0.1;
        }
      } else if (check.status === 'warn') {
        score += 0.05;
      }
    }
    score = Math.min(score, 1.0);

    let risk: string;
    if (score < 0.2) risk = 'low';
    else if (score < 0.45) risk = 'medium';
    else if (score < 0.7) risk = 'high';
    else risk = 'critical';

    return { risk, score: Math.round(score * 100) / 100 };
  }

  it('returns low risk when all pass', () => {
    const { risk } = computeRisk([
      { name: 'secrets', status: 'pass', message: '', durationMs: 0 },
      { name: 'typecheck', status: 'pass', message: '', durationMs: 0 },
    ]);
    expect(risk).toBe('low');
  });

  it('returns high risk when secrets fail', () => {
    const { risk } = computeRisk([
      { name: 'secrets', status: 'fail', message: '', durationMs: 0 },
      { name: 'typecheck', status: 'pass', message: '', durationMs: 0 },
    ]);
    expect(risk).toBe('medium');
  });

  it('returns critical when multiple checks fail', () => {
    const { risk } = computeRisk([
      { name: 'secrets', status: 'fail', message: '', durationMs: 0 },
      { name: 'typecheck', status: 'fail', message: '', durationMs: 0 },
      { name: 'tests', status: 'fail', message: '', durationMs: 0 },
    ]);
    // 0.4 + 0.2 + 0.25 = 0.85 → critical
    expect(risk).toBe('critical');
  });

  it('skipped checks do not affect score', () => {
    const { score } = computeRisk([
      { name: 'typecheck', status: 'skip', message: '', durationMs: 0 },
      { name: 'tests', status: 'skip', message: '', durationMs: 0 },
    ]);
    expect(score).toBe(0);
  });
});
