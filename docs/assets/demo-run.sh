#!/bin/bash
printf '\nProvider: \033[36mcopilot\033[0m, Model: \033[36mdefault\033[0m\n'
printf '\033[2m───\033[0m \033[1;35mPlan: Add validation\033[0m \033[2m(3 subtasks) ───\033[0m\n'
printf '\033[33m[Worker 1]\033[0m Reading src/api/users.ts\n'
sleep 0.3
printf '\033[33m[Worker 1]\033[0m Added Zod validation to createUser\n'
printf '\033[34m[Worker 2]\033[0m Reading src/api/posts.ts\n'
sleep 0.3
printf '\033[34m[Worker 2]\033[0m Added Zod validation to createPost\n'
printf '\033[32m[Worker 3]\033[0m Writing tests...\n'
sleep 0.3
printf '\033[33m[Worker 1]\033[0m \033[32m✓ Done\033[0m\n'
printf '\033[34m[Worker 2]\033[0m \033[32m✓ Done\033[0m\n'
printf '\033[32m[Worker 3]\033[0m \033[32m✓ Done\033[0m — 6/6 tests pass\n'
printf '\n\033[2m[3/3 complete | 2,400 tokens]\033[0m\n'
printf '\nFiles changed: src/api/users.ts, src/api/posts.ts, src/api/__tests__/validation.test.ts\n'
printf '\n\033[32mTask complete.\033[0m\n'
