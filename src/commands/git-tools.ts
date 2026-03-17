/**
 * `jam git` — Git Swiss army knife for developers.
 * Zero LLM required. Explains git state in plain English and offers safe fixes.
 */

import { execSync } from 'node:child_process';
import chalk from 'chalk';

// ── Helpers ──────────────────────────────────────────────────────────────────

function git(cmd: string, cwd?: string): string {
  try {
    return execSync(`git ${cmd}`, {
      cwd: cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    }).toString().trim();
  } catch {
    return '';
  }
}

function gitOrFail(cmd: string): string {
  return execSync(`git ${cmd}`, {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
  }).toString().trim();
}

// ── jam git wtf ──────────────────────────────────────────────────────────────

export function runGitWtf(): void {
  
  const out: string[] = [''];

  // Check if we're in a git repo
  const isGit = git('rev-parse --is-inside-work-tree');
  if (isGit !== 'true') {
    out.push(chalk.red('  Not a git repository.'));
    out.push('');
    process.stdout.write(out.join('\n') + '\n');
    return;
  }

  out.push(chalk.bold('  Git Status Report'));
  out.push(chalk.dim('  ─────────────────────────────────────────'));
  out.push('');

  // Branch info
  const branch = git('branch --show-current');
  const headRef = git('rev-parse --short HEAD');

  if (!branch) {
    const detachedAt = git('describe --tags --exact-match HEAD 2>/dev/null') || headRef;
    out.push(`  ${chalk.yellow('⚠ Detached HEAD')} at ${chalk.bold(detachedAt)}`);
    out.push(chalk.dim('    You\'re not on any branch. Commits here may be lost.'));
    out.push(chalk.dim(`    Fix: ${chalk.white('git checkout <branch>')}`));
    out.push(chalk.dim(`    Or create a new branch: ${chalk.white('git checkout -b my-branch')}`));
  } else {
    out.push(`  ${chalk.dim('Branch:')}  ${chalk.bold(branch)} (${headRef})`);
  }

  // Upstream tracking
  if (branch) {
    const upstream = git(`rev-parse --abbrev-ref ${branch}@{upstream} 2>/dev/null`);
    if (!upstream) {
      out.push(`  ${chalk.yellow('⚠ No upstream')} — this branch isn't tracking a remote`);
      out.push(chalk.dim(`    Push with: ${chalk.white(`git push -u origin ${branch}`)}`));
    } else {
      const ahead = git(`rev-list --count ${upstream}..HEAD`);
      const behind = git(`rev-list --count HEAD..${upstream}`);
      const aheadN = parseInt(ahead) || 0;
      const behindN = parseInt(behind) || 0;

      if (aheadN > 0 && behindN > 0) {
        out.push(`  ${chalk.yellow(`⚠ Diverged`)} — ${aheadN} ahead, ${behindN} behind ${chalk.dim(upstream)}`);
        out.push(chalk.dim(`    You and the remote have both changed.`));
        out.push(chalk.dim(`    Option 1 (rebase): ${chalk.white('git pull --rebase')}`));
        out.push(chalk.dim(`    Option 2 (merge):  ${chalk.white('git pull')}`));
      } else if (aheadN > 0) {
        out.push(`  ${chalk.green(`↑ ${aheadN} commit${aheadN > 1 ? 's' : ''} ahead`)} of ${chalk.dim(upstream)}`);
        out.push(chalk.dim(`    Ready to push: ${chalk.white('git push')}`));
      } else if (behindN > 0) {
        out.push(`  ${chalk.yellow(`↓ ${behindN} commit${behindN > 1 ? 's' : ''} behind`)} ${chalk.dim(upstream)}`);
        out.push(chalk.dim(`    Update with: ${chalk.white('git pull')}`));
      } else {
        out.push(`  ${chalk.green('✓ Up to date')} with ${chalk.dim(upstream)}`);
      }
    }
  }

  out.push('');

  // Working tree state
  const status = git('status --porcelain');
  if (!status) {
    out.push(`  ${chalk.green('✓ Working tree clean')}`);
  } else {
    const lines = status.split('\n');
    const staged = lines.filter(l => /^[MADRC]/.test(l)).length;
    const modified = lines.filter(l => /^.[MD]/.test(l)).length;
    const untracked = lines.filter(l => l.startsWith('??')).length;
    const conflicts = lines.filter(l => /^(U.|.U|AA|DD)/.test(l)).length;

    if (conflicts > 0) {
      out.push(`  ${chalk.red(`✕ ${conflicts} merge conflict${conflicts > 1 ? 's' : ''}`)}`);
      out.push(chalk.dim('    Fix conflicts, then:'));
      out.push(chalk.dim(`    ${chalk.white('git add <resolved-files>')}`));
      out.push(chalk.dim(`    ${chalk.white('git commit')} (or ${chalk.white('git rebase --continue')})`));
    }
    if (staged > 0) {
      out.push(`  ${chalk.green(`● ${staged} staged`)} — ready to commit`);
    }
    if (modified > 0) {
      out.push(`  ${chalk.yellow(`● ${modified} modified`)} — not staged yet`);
      out.push(chalk.dim(`    Stage: ${chalk.white('git add <file>')} or ${chalk.white('git add -p')} (interactive)`));
    }
    if (untracked > 0) {
      out.push(`  ${chalk.dim(`● ${untracked} untracked`)} — new files`);
      out.push(chalk.dim(`    Track: ${chalk.white('git add <file>')}`));
    }
  }

  // Mid-operation detection
  const gitDir = git('rev-parse --git-dir');
  if (gitDir) {
    const rebaseMerge = git(`test -d ${gitDir}/rebase-merge && echo yes`);
    const rebaseApply = git(`test -d ${gitDir}/rebase-apply && echo yes`);
    const mergeHead = git(`test -f ${gitDir}/MERGE_HEAD && echo yes`);
    const cherryPick = git(`test -f ${gitDir}/CHERRY_PICK_HEAD && echo yes`);
    const revert = git(`test -f ${gitDir}/REVERT_HEAD && echo yes`);
    const bisect = git(`test -f ${gitDir}/BISECT_LOG && echo yes`);

    if (rebaseMerge === 'yes' || rebaseApply === 'yes') {
      out.push('');
      out.push(`  ${chalk.yellow('⚠ Rebase in progress')}`);
      out.push(chalk.dim(`    Continue: ${chalk.white('git rebase --continue')}`));
      out.push(chalk.dim(`    Abort:    ${chalk.white('git rebase --abort')}`));
    }
    if (mergeHead === 'yes') {
      out.push('');
      out.push(`  ${chalk.yellow('⚠ Merge in progress')}`);
      out.push(chalk.dim(`    Finish:   ${chalk.white('git commit')}`));
      out.push(chalk.dim(`    Abort:    ${chalk.white('git merge --abort')}`));
    }
    if (cherryPick === 'yes') {
      out.push('');
      out.push(`  ${chalk.yellow('⚠ Cherry-pick in progress')}`);
      out.push(chalk.dim(`    Continue: ${chalk.white('git cherry-pick --continue')}`));
      out.push(chalk.dim(`    Abort:    ${chalk.white('git cherry-pick --abort')}`));
    }
    if (revert === 'yes') {
      out.push('');
      out.push(`  ${chalk.yellow('⚠ Revert in progress')}`);
      out.push(chalk.dim(`    Continue: ${chalk.white('git revert --continue')}`));
      out.push(chalk.dim(`    Abort:    ${chalk.white('git revert --abort')}`));
    }
    if (bisect === 'yes') {
      out.push('');
      out.push(`  ${chalk.yellow('⚠ Bisect in progress')}`);
      out.push(chalk.dim(`    Mark:  ${chalk.white('git bisect good')} / ${chalk.white('git bisect bad')}`));
      out.push(chalk.dim(`    Abort: ${chalk.white('git bisect reset')}`));
    }
  }

  // Stashes
  const stashCount = git('stash list | wc -l').trim();
  const stashes = parseInt(stashCount) || 0;
  if (stashes > 0) {
    out.push('');
    out.push(`  ${chalk.dim(`📦 ${stashes} stash${stashes > 1 ? 'es' : ''} saved`)}`);
    out.push(chalk.dim(`    View:  ${chalk.white('git stash list')}`));
    out.push(chalk.dim(`    Apply: ${chalk.white('git stash pop')}`));
  }

  // Last commit
  const lastCommit = git('log -1 --format="%h %s (%cr)"');
  if (lastCommit) {
    out.push('');
    out.push(`  ${chalk.dim('Last commit:')} ${lastCommit}`);
  }

  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

// ── jam git undo ─────────────────────────────────────────────────────────────

export function runGitUndo(options: { dryRun?: boolean }): void {
  
  const out: string[] = [''];
  const dryRun = options.dryRun ?? false;

  // Figure out what the last operation was
  const reflog = git('reflog -1 --format="%gs"');
  const lastHash = git('rev-parse HEAD');

  if (!reflog) {
    out.push(chalk.yellow('  No reflog entry found — nothing to undo.'));
    out.push('');
    process.stdout.write(out.join('\n') + '\n');
    return;
  }

  out.push(chalk.bold('  Undo Last Git Operation'));
  out.push(chalk.dim('  ─────────────────────────────────────────'));
  out.push('');
  out.push(`  ${chalk.dim('Last operation:')} ${reflog}`);
  out.push(`  ${chalk.dim('Current HEAD:')}   ${lastHash.slice(0, 8)}`);
  out.push('');

  let undoCmd = '';
  let explanation = '';

  if (reflog.startsWith('commit:') || reflog.startsWith('commit (initial)')) {
    undoCmd = 'git reset --soft HEAD~1';
    explanation = 'This moves HEAD back one commit but keeps your changes staged.\nYour code is safe — nothing is deleted.';
  } else if (reflog.startsWith('commit (amend)')) {
    const prevHash = git('reflog -1 --format="%H"');
    undoCmd = `git reset --soft ${prevHash}`;
    explanation = 'This undoes the amend, restoring the previous commit.\nYour amended changes remain staged.';
  } else if (reflog.startsWith('merge')) {
    undoCmd = 'git reset --merge HEAD~1';
    explanation = 'This undoes the merge commit.\nIf the merge had conflicts you resolved, they may need to be re-resolved.';
  } else if (reflog.startsWith('rebase')) {
    const origHead = git('cat .git/ORIG_HEAD 2>/dev/null');
    if (origHead) {
      undoCmd = `git reset --hard ${origHead.slice(0, 8)}`;
      explanation = 'This restores the branch to its state before the rebase.\nWarning: uncommitted changes will be lost.';
    } else {
      undoCmd = 'git reflog  # find the commit before rebase and: git reset --hard <hash>';
      explanation = 'ORIG_HEAD not found. Check reflog to find the pre-rebase state.';
    }
  } else if (reflog.startsWith('pull')) {
    undoCmd = 'git reset --hard HEAD@{1}';
    explanation = 'This resets to the state before the pull.\nWarning: any merge resolution will be lost.';
  } else if (reflog.startsWith('checkout:')) {
    const prevBranch = git('reflog -1 --format="%gs"').replace('checkout: moving from ', '').split(' to ')[0];
    undoCmd = `git checkout ${prevBranch}`;
    explanation = `This switches back to the branch you were on: ${prevBranch}`;
  } else if (reflog.startsWith('reset:')) {
    undoCmd = 'git reset HEAD@{1}';
    explanation = 'This undoes the reset, restoring HEAD to its previous position.';
  } else {
    undoCmd = 'git reset HEAD@{1}';
    explanation = `Unknown operation: "${reflog}". This generic undo restores HEAD to its previous reflog entry.`;
  }

  out.push(`  ${chalk.bold('Suggested undo:')}`);
  out.push(`  ${chalk.green(`$ ${undoCmd}`)}`);
  out.push('');
  out.push(`  ${chalk.dim(explanation.split('\n').join('\n  '))}`);
  out.push('');

  if (dryRun) {
    out.push(chalk.dim('  (dry run — no changes made)'));
  } else {
    out.push(chalk.dim(`  Run the command above to undo. Use ${chalk.white('--dry')} to preview without executing.`));
  }

  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

// ── jam git cleanup ──────────────────────────────────────────────────────────

export function runGitCleanup(options: { dryRun?: boolean; json?: boolean }): void {
  
  const dryRun = options.dryRun ?? false;

  // Find merged branches
  const defaultBranch = git('symbolic-ref refs/remotes/origin/HEAD 2>/dev/null')
    .replace('refs/remotes/origin/', '') || 'main';
  const mergedRaw = git(`branch --merged ${defaultBranch}`);
  const merged = mergedRaw
    .split('\n')
    .map(b => b.trim().replace(/^\*\s*/, ''))
    .filter(b => b && b !== defaultBranch && b !== 'main' && b !== 'master' && !b.startsWith('('));

  // Find stale remote branches
  git('remote prune origin --dry-run');
  const staleRaw = git('remote prune origin --dry-run 2>/dev/null');
  const stale = staleRaw
    .split('\n')
    .filter(l => l.includes('[would prune]'))
    .map(l => l.replace(/.*\[would prune\]\s*/, '').trim());

  // Find old branches (no commits in 90 days)
  const allBranches = git('branch --format="%(refname:short) %(committerdate:unix)"')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const parts = line.split(' ');
      const name = parts.slice(0, -1).join(' ');
      const ts = parseInt(parts[parts.length - 1]!) || 0;
      return { name, ts };
    });
  const ninetyDaysAgo = Date.now() / 1000 - 90 * 24 * 60 * 60;
  const oldBranches = allBranches
    .filter(b => b.ts < ninetyDaysAgo && b.name !== defaultBranch && b.name !== 'main' && b.name !== 'master')
    .map(b => b.name);

  if (options.json) {
    process.stdout.write(JSON.stringify({ merged, stale, oldBranches }, null, 2) + '\n');
    return;
  }

  const out: string[] = [''];
  out.push(chalk.bold('  Git Cleanup'));
  out.push(chalk.dim('  ─────────────────────────────────────────'));

  if (merged.length > 0) {
    out.push('');
    out.push(`  ${chalk.green(`${merged.length} merged branch${merged.length > 1 ? 'es' : ''}`)} — safe to delete:`);
    for (const b of merged) {
      out.push(`    ${chalk.dim('•')} ${b}`);
    }
    if (!dryRun) {
      for (const b of merged) {
        try { gitOrFail(`branch -d ${b}`); } catch { /* skip protected */ }
      }
      out.push(chalk.dim(`    Deleted ${merged.length} merged branches.`));
    } else {
      out.push(chalk.dim(`    (dry run — run without ${chalk.white('--dry')} to delete)`));
    }
  }

  if (stale.length > 0) {
    out.push('');
    out.push(`  ${chalk.yellow(`${stale.length} stale remote ref${stale.length > 1 ? 's' : ''}`)}:`);
    for (const s of stale) {
      out.push(`    ${chalk.dim('•')} ${s}`);
    }
    if (!dryRun) {
      git('remote prune origin');
      out.push(chalk.dim('    Pruned stale remote references.'));
    } else {
      out.push(chalk.dim(`    (dry run — run without ${chalk.white('--dry')} to prune)`));
    }
  }

  if (oldBranches.length > 0) {
    out.push('');
    out.push(`  ${chalk.dim(`${oldBranches.length} branch${oldBranches.length > 1 ? 'es' : ''} with no activity in 90+ days:`)}`);
    for (const b of oldBranches.slice(0, 10)) {
      out.push(`    ${chalk.dim('•')} ${b}`);
    }
    if (oldBranches.length > 10) out.push(chalk.dim(`    ... and ${oldBranches.length - 10} more`));
    out.push(chalk.dim(`    Review and delete manually: ${chalk.white('git branch -d <name>')}`));
  }

  if (merged.length === 0 && stale.length === 0 && oldBranches.length === 0) {
    out.push('');
    out.push(`  ${chalk.green('✓ Already clean')} — no merged, stale, or old branches found.`);
  }

  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

// ── jam git standup ──────────────────────────────────────────────────────────

export function runGitStandup(options: { days?: number; author?: string; json?: boolean }): void {
  
  const days = options.days ?? 1;
  const author = options.author || git('config user.name');

  const rawLog = git(
    `log --all --author="${author}" --since="${days} days ago" --format="%h|%s|%cr|%D" --no-merges`
  );

  if (!rawLog) {
    if (options.json) {
      process.stdout.write('[]\n');
    } else {
      process.stdout.write(`\n  No commits from ${chalk.bold(author)} in the last ${days} day${days > 1 ? 's' : ''}.\n\n`);
    }
    return;
  }

  const commits = rawLog.split('\n').map(line => {
    const [hash = '', message = '', when = '', refs] = line.split('|');
    return { hash, message, when, refs: refs || undefined };
  });

  if (options.json) {
    process.stdout.write(JSON.stringify(commits, null, 2) + '\n');
    return;
  }

  const out: string[] = [''];
  out.push(`  ${chalk.bold(`Standup — ${author}`)} ${chalk.dim(`(last ${days} day${days > 1 ? 's' : ''})`)}`);
  out.push(chalk.dim('  ─────────────────────────────────────────'));
  out.push('');

  for (const commit of commits) {
    const refBadge = commit.refs
      ? ` ${chalk.dim('(')}${chalk.hex('#2d7d6f')(commit.refs)}${chalk.dim(')')}`
      : '';
    out.push(`  ${chalk.dim(commit.hash)} ${commit.message}${refBadge}`);
    out.push(`         ${chalk.dim(commit.when)}`);
  }

  out.push('');
  out.push(chalk.dim(`  ${commits.length} commit${commits.length > 1 ? 's' : ''} total`));
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

// ── jam git oops ─────────────────────────────────────────────────────────────

export function runGitOops(): void {
  
  const accent = chalk.hex('#2d7d6f');

  const scenarios = [
    {
      title: 'I committed to the wrong branch',
      steps: [
        'git log --oneline -3          # note the commit hash(es)',
        'git checkout correct-branch',
        'git cherry-pick <hash>        # apply the commit here',
        'git checkout wrong-branch',
        'git reset --hard HEAD~1       # remove from wrong branch',
      ],
    },
    {
      title: 'I need to change the last commit message',
      steps: [
        'git commit --amend -m "new message"',
        '# Warning: only do this BEFORE pushing!',
      ],
    },
    {
      title: 'I accidentally staged a file',
      steps: [
        'git restore --staged <file>   # unstage, keep changes',
        '# Or unstage everything:',
        'git restore --staged .',
      ],
    },
    {
      title: 'I want to undo my last commit but keep the changes',
      steps: [
        'git reset --soft HEAD~1       # undo commit, keep staged',
        '# Or undo and unstage:',
        'git reset HEAD~1              # undo commit, keep as modified',
      ],
    },
    {
      title: 'I accidentally deleted a branch',
      steps: [
        'git reflog                    # find the branch tip hash',
        'git checkout -b <branch-name> <hash>',
      ],
    },
    {
      title: 'I need to undo a pushed commit (safely)',
      steps: [
        'git revert <hash>            # creates a new "undo" commit',
        'git push                     # safe — no force push needed',
        '# Never use reset --hard on pushed commits!',
      ],
    },
    {
      title: 'I have merge conflicts and I\'m panicking',
      steps: [
        'git status                   # see which files have conflicts',
        '# Open each conflicted file, look for <<<< ==== >>>> markers',
        '# Choose the code you want, delete the markers',
        'git add <resolved-file>      # mark as resolved',
        'git commit                   # finish the merge',
        '# Or give up:  git merge --abort',
      ],
    },
    {
      title: 'I want to save my work without committing',
      steps: [
        'git stash                    # save everything',
        'git stash -m "description"   # save with a label',
        'git stash pop                # restore later',
        'git stash list               # see all stashes',
      ],
    },
    {
      title: 'I want to see what changed in a file',
      steps: [
        'git diff <file>              # unstaged changes',
        'git diff --staged <file>     # staged changes',
        'git log -p <file>            # full history of changes',
        'git blame <file>             # who changed each line',
      ],
    },
    {
      title: 'I need to update my branch with the latest main',
      steps: [
        'git checkout main && git pull',
        'git checkout my-branch',
        'git rebase main              # replay your commits on top',
        '# Or merge:  git merge main  # (creates a merge commit)',
      ],
    },
  ];

  const out: string[] = [''];
  out.push(accent('  Git Oops — Common Fixes'));
  out.push(chalk.dim('  ─────────────────────────────────────────'));

  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i]!;
    out.push('');
    out.push(`  ${chalk.bold(`${i + 1}. ${s.title}`)}`);
    for (const step of s.steps) {
      if (step.startsWith('#')) {
        out.push(`     ${chalk.dim(step)}`);
      } else {
        out.push(`     ${chalk.green('$')} ${step}`);
      }
    }
  }

  out.push('');
  out.push(chalk.dim('  Tip: Use `jam git undo` to automatically detect and undo your last operation.'));
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}
