#!/bin/bash
# Clean demo for asciinema recording

sleep 0.5

# Scene 1: jam trace --impact
printf '\033[32m$\033[0m '
sleep 0.3
for c in j a m ' ' t r a c e ' ' u p d a t e B a l a n c e ' ' - - i m p a c t; do
  printf '%s' "$c"
  sleep 0.035
done
printf '\n'
sleep 0.6

printf '\n'
printf '\033[1;36mImpact Analysis for updateBalance\033[0m\n'
printf '\033[2m═══════════════════════════════════════\033[0m\n'
printf '\n'
sleep 0.15
printf 'Direct callers:\n'
printf '  → PaymentService.processRefund() \033[2m[Java]\033[0m (line 142)\n'
sleep 0.1
printf '  → BATCH_NIGHTLY_RECONCILE \033[2m[SQL]\033[0m (line 34)\n'
printf '\n'
sleep 0.15
printf 'Column dependents:\n'
printf '  → VIEW v_customer_summary \033[2m(reads customer.balance)\033[0m\n'
sleep 0.1
printf '  → PROC_MONTHLY_STATEMENT \033[2m(reads customer.balance)\033[0m\n'
printf '\n'
sleep 0.15
printf 'Trigger chain:\n'
printf '  → TRG_CUSTOMER_AUDIT fires on UPDATE customer\n'
printf '\n'
sleep 0.1
printf 'Risk: \033[1;33mHIGH\033[0m — 2 callers across 2 languages, 2 column dependents\n'
sleep 2.5

printf '\n'

# Scene 2: jam git wtf
printf '\033[32m$\033[0m '
sleep 0.3
for c in j a m ' ' g i t ' ' w t f; do
  printf '%s' "$c"
  sleep 0.035
done
printf '\n'
sleep 0.6

printf '\n'
printf '\033[1;36mGit Status — Explained\033[0m\n'
printf '\033[2m───────────────────────────────────\033[0m\n'
printf '\n'
sleep 0.15
printf '\033[1mBranch:\033[0m  feat/auth-refactor (4 ahead of main)\n'
printf '\033[1mStaged:\033[0m  3 files — src/auth/*.ts\n'
printf '\033[1mModified:\033[0m 1 file — package.json\n'
printf '\033[1mStash:\033[0m   1 entry\n'
printf '\n'
sleep 0.15
printf '\033[1;32mSuggestion:\033[0m Your auth refactor looks ready.\n'
printf 'Commit the staged files, then rebase onto main.\n'
sleep 2.5

printf '\n'

# Scene 3: jam run
printf '\033[32m$\033[0m '
sleep 0.3
for c in j a m ' ' r u n ' ' "'" a d d ' ' v a l i d a t i o n "'" ' ' - - y e s; do
  printf '%s' "$c"
  sleep 0.035
done
printf '\n'
sleep 0.6

printf '\n'
printf 'Provider: \033[36mcopilot\033[0m, Model: \033[36mdefault\033[0m\n'
printf '\033[2m───\033[0m \033[1;35mPlan: Add validation\033[0m \033[2m(3 subtasks) ───\033[0m\n'
sleep 0.2
printf '\033[33m[Worker 1]\033[0m Reading src/api/users.ts\n'
sleep 0.25
printf '\033[34m[Worker 2]\033[0m Reading src/api/posts.ts\n'
sleep 0.25
printf '\033[33m[Worker 1]\033[0m Added Zod validation to createUser\n'
sleep 0.15
printf '\033[34m[Worker 2]\033[0m Added Zod validation to createPost\n'
sleep 0.15
printf '\033[32m[Worker 3]\033[0m Writing tests...\n'
sleep 0.4
printf '\033[33m[Worker 1]\033[0m \033[32m✓ Done\033[0m\n'
printf '\033[34m[Worker 2]\033[0m \033[32m✓ Done\033[0m\n'
printf '\033[32m[Worker 3]\033[0m \033[32m✓ Done\033[0m — 6/6 tests pass\n'
printf '\n'
printf '\033[2m[3/3 complete | 2,400 tokens]\033[0m\n'
printf '\033[32mTask complete.\033[0m\n'

sleep 2
