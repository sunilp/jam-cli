import { describe, it, expect, beforeEach } from 'vitest';
import { classifyCommand, PermissionClassifier, ApprovalTracker, isHardBlocked } from './permissions.js';

describe('classifyCommand', () => {
  // Safe commands
  it('classifies ls as safe', () => {
    expect(classifyCommand('ls')).toBe('safe');
    expect(classifyCommand('ls -la')).toBe('safe');
  });

  it('classifies cat as safe', () => {
    expect(classifyCommand('cat file.txt')).toBe('safe');
  });

  it('classifies head and tail as safe', () => {
    expect(classifyCommand('head -n 10 file.txt')).toBe('safe');
    expect(classifyCommand('tail -f app.log')).toBe('safe');
  });

  it('classifies wc as safe', () => {
    expect(classifyCommand('wc -l src/index.ts')).toBe('safe');
  });

  it('classifies echo as safe', () => {
    expect(classifyCommand('echo hello')).toBe('safe');
  });

  it('classifies git status as safe', () => {
    expect(classifyCommand('git status')).toBe('safe');
    expect(classifyCommand('git status --short')).toBe('safe');
  });

  it('classifies git diff as safe', () => {
    expect(classifyCommand('git diff')).toBe('safe');
    expect(classifyCommand('git diff HEAD~1')).toBe('safe');
  });

  it('classifies git log as safe', () => {
    expect(classifyCommand('git log --oneline -10')).toBe('safe');
  });

  it('classifies git show as safe', () => {
    expect(classifyCommand('git show HEAD')).toBe('safe');
  });

  it('classifies git branch as safe (list only)', () => {
    expect(classifyCommand('git branch')).toBe('safe');
    expect(classifyCommand('git branch -v')).toBe('safe');
  });

  it('classifies git tag as safe', () => {
    expect(classifyCommand('git tag')).toBe('safe');
  });

  it('classifies git remote as safe', () => {
    expect(classifyCommand('git remote -v')).toBe('safe');
  });

  it('classifies git rev-parse as safe', () => {
    expect(classifyCommand('git rev-parse HEAD')).toBe('safe');
  });

  it('classifies npm test as safe', () => {
    expect(classifyCommand('npm test')).toBe('safe');
    expect(classifyCommand('npm test -- --watch')).toBe('safe');
  });

  it('classifies npx vitest/jest/tsc/eslint/prettier as safe', () => {
    expect(classifyCommand('npx vitest run')).toBe('safe');
    expect(classifyCommand('npx jest')).toBe('safe');
    expect(classifyCommand('npx tsc --noEmit')).toBe('safe');
    expect(classifyCommand('npx eslint src/')).toBe('safe');
    expect(classifyCommand('npx prettier --check .')).toBe('safe');
  });

  it('classifies node as safe', () => {
    expect(classifyCommand('node script.js')).toBe('safe');
  });

  it('classifies deno as safe', () => {
    expect(classifyCommand('deno run mod.ts')).toBe('safe');
  });

  it('classifies bun test/run as safe', () => {
    expect(classifyCommand('bun test')).toBe('safe');
    expect(classifyCommand('bun run build')).toBe('safe');
  });

  it('classifies cargo test as safe', () => {
    expect(classifyCommand('cargo test')).toBe('safe');
  });

  it('classifies go test as safe', () => {
    expect(classifyCommand('go test ./...')).toBe('safe');
  });

  it('classifies python -m pytest as safe', () => {
    expect(classifyCommand('python -m pytest tests/')).toBe('safe');
  });

  it('classifies pwd, whoami, date, which, env as safe', () => {
    expect(classifyCommand('pwd')).toBe('safe');
    expect(classifyCommand('whoami')).toBe('safe');
    expect(classifyCommand('date')).toBe('safe');
    expect(classifyCommand('which node')).toBe('safe');
    expect(classifyCommand('env')).toBe('safe');
  });

  it('classifies find, grep, rg, fd as safe', () => {
    expect(classifyCommand('find . -name "*.ts"')).toBe('safe');
    expect(classifyCommand('grep -r TODO src/')).toBe('safe');
    expect(classifyCommand('rg "pattern" .')).toBe('safe');
    expect(classifyCommand('fd ".ts$"')).toBe('safe');
  });

  // Moderate commands
  it('classifies npm install as moderate', () => {
    expect(classifyCommand('npm install lodash')).toBe('moderate');
  });

  it('classifies git add as moderate', () => {
    expect(classifyCommand('git add .')).toBe('moderate');
    expect(classifyCommand('git add src/index.ts')).toBe('moderate');
  });

  it('classifies git commit as moderate', () => {
    expect(classifyCommand('git commit -m "fix: bug"')).toBe('moderate');
  });

  it('classifies mkdir as moderate', () => {
    expect(classifyCommand('mkdir -p src/utils')).toBe('moderate');
  });

  it('classifies rm of a single file as moderate', () => {
    expect(classifyCommand('rm file.txt')).toBe('moderate');
  });

  it('classifies curl as moderate', () => {
    expect(classifyCommand('curl https://example.com')).toBe('moderate');
  });

  // Dangerous commands
  it('classifies rm -rf as dangerous', () => {
    expect(classifyCommand('rm -rf node_modules')).toBe('dangerous');
    expect(classifyCommand('rm -fr dist')).toBe('dangerous');
  });

  it('classifies rm -f as dangerous', () => {
    expect(classifyCommand('rm -f important.txt')).toBe('dangerous');
  });

  it('classifies git push as dangerous', () => {
    expect(classifyCommand('git push')).toBe('dangerous');
    expect(classifyCommand('git push origin main')).toBe('dangerous');
  });

  it('classifies git reset as dangerous', () => {
    expect(classifyCommand('git reset --hard HEAD~1')).toBe('dangerous');
    expect(classifyCommand('git reset HEAD')).toBe('dangerous');
  });

  it('classifies git rebase as dangerous', () => {
    expect(classifyCommand('git rebase main')).toBe('dangerous');
  });

  it('classifies git checkout -- as dangerous', () => {
    expect(classifyCommand('git checkout -- .')).toBe('dangerous');
  });

  it('classifies git branch -d/-D as dangerous', () => {
    expect(classifyCommand('git branch -d feature/old')).toBe('dangerous');
    expect(classifyCommand('git branch -D feature/old')).toBe('dangerous');
  });

  it('classifies chmod as dangerous', () => {
    expect(classifyCommand('chmod +x script.sh')).toBe('dangerous');
  });

  it('classifies chown as dangerous', () => {
    expect(classifyCommand('chown user:group file')).toBe('dangerous');
  });

  it('classifies piped commands as dangerous', () => {
    expect(classifyCommand('echo "x" | bash')).toBe('dangerous');
    expect(classifyCommand('cat file.txt | wc -l')).toBe('dangerous');
  });
});

describe('PermissionClassifier', () => {
  it('classifies normally with no overrides', () => {
    const classifier = new PermissionClassifier({ safe: [], dangerous: [] });
    expect(classifier.classify('ls -la')).toBe('safe');
    expect(classifier.classify('npm install')).toBe('moderate');
    expect(classifier.classify('git push')).toBe('dangerous');
  });

  it('custom safe override promotes a command to safe', () => {
    const classifier = new PermissionClassifier({
      safe: ['npm install'],
      dangerous: [],
    });
    expect(classifier.classify('npm install lodash')).toBe('safe');
  });

  it('custom dangerous override demotes a command to dangerous', () => {
    const classifier = new PermissionClassifier({
      safe: [],
      dangerous: ['curl'],
    });
    expect(classifier.classify('curl https://example.com')).toBe('dangerous');
  });

  it('custom dangerous override takes precedence over custom safe override', () => {
    const classifier = new PermissionClassifier({
      safe: ['npm'],
      dangerous: ['npm install'],
    });
    // dangerous checked before safe — npm install is dangerous
    expect(classifier.classify('npm install react')).toBe('dangerous');
    // npm test is safe (no dangerous prefix match, safe prefix matches 'npm')
    expect(classifier.classify('npm test')).toBe('safe');
  });

  it('hard-block cannot be overridden by custom safe list', () => {
    const classifier = new PermissionClassifier({
      safe: ['sudo', 'reboot'],
      dangerous: [],
    });
    expect(classifier.classify('sudo rm -rf /')).toBe('blocked');
    expect(classifier.classify('reboot')).toBe('blocked');
  });

  it('hard-block cannot be overridden by custom dangerous list either', () => {
    const classifier = new PermissionClassifier({
      safe: [],
      dangerous: ['sudo'],
    });
    expect(classifier.classify('sudo apt-get install vim')).toBe('blocked');
  });

  it('returns blocked for hard-blocked commands', () => {
    const classifier = new PermissionClassifier({ safe: [], dangerous: [] });
    expect(classifier.classify('sudo apt install vim')).toBe('blocked');
    expect(classifier.classify('mkfs /dev/sda')).toBe('blocked');
  });
});

describe('isHardBlocked', () => {
  it('blocks sudo', () => {
    expect(isHardBlocked('sudo rm -rf /')).toBe(true);
    expect(isHardBlocked('sudo apt install vim')).toBe(true);
  });

  it('blocks su -', () => {
    expect(isHardBlocked('su -')).toBe(true);
    expect(isHardBlocked('su')).toBe(true);
  });

  it('blocks mkfs', () => {
    expect(isHardBlocked('mkfs /dev/sda1')).toBe(true);
  });

  it('blocks dd', () => {
    expect(isHardBlocked('dd if=/dev/zero of=/dev/sda')).toBe(true);
  });

  it('blocks chmod 777 /', () => {
    expect(isHardBlocked('chmod 777 /')).toBe(true);
  });

  it('blocks shutdown', () => {
    expect(isHardBlocked('shutdown now')).toBe(true);
    expect(isHardBlocked('shutdown -h now')).toBe(true);
  });

  it('blocks reboot', () => {
    expect(isHardBlocked('reboot')).toBe(true);
  });

  it('blocks rm -rf /', () => {
    expect(isHardBlocked('rm -rf /')).toBe(true);
    expect(isHardBlocked('rm -fr /')).toBe(true);
  });

  it('does not block normal commands', () => {
    expect(isHardBlocked('ls -la')).toBe(false);
    expect(isHardBlocked('git status')).toBe(false);
    expect(isHardBlocked('npm install')).toBe(false);
    expect(isHardBlocked('rm -rf node_modules')).toBe(false);
    expect(isHardBlocked('chmod +x script.sh')).toBe(false);
  });
});

describe('ApprovalTracker', () => {
  let tracker: ApprovalTracker;

  beforeEach(() => {
    tracker = new ApprovalTracker();
  });

  it('returns false for a command that has not been approved', () => {
    expect(tracker.isApproved('git push origin main')).toBe(false);
  });

  it('returns true after approve() is called', () => {
    tracker.approve('git push origin main');
    expect(tracker.isApproved('git push origin main')).toBe(true);
  });

  it('normalizes to first 2 words — different args match same type', () => {
    tracker.approve('git push origin main');
    expect(tracker.isApproved('git push upstream feature/x')).toBe(true);
  });

  it('does not cross-match different 2-word types', () => {
    tracker.approve('git push origin main');
    expect(tracker.isApproved('git commit -m "msg"')).toBe(false);
  });

  it('single-word commands normalize correctly', () => {
    // 'reboot' has 1 word → key is "reboot"
    tracker.approve('reboot');
    expect(tracker.isApproved('reboot')).toBe(true);
    // 'reboot --force' has 2 words → key is "reboot --force", different from "reboot"
    expect(tracker.isApproved('reboot --force')).toBe(false);
    // approve the 2-word form separately
    tracker.approve('reboot --force');
    expect(tracker.isApproved('reboot --force')).toBe(true);
  });

  it('tracks multiple approved types independently', () => {
    tracker.approve('npm install lodash');
    tracker.approve('git push origin main');
    expect(tracker.isApproved('npm install react')).toBe(true);
    expect(tracker.isApproved('git push upstream dev')).toBe(true);
    expect(tracker.isApproved('npm run build')).toBe(false);
  });

  it('approving again is idempotent', () => {
    tracker.approve('git push origin main');
    tracker.approve('git push upstream dev');
    expect(tracker.isApproved('git push')).toBe(true);
  });
});
