<div align="center">

<pre>
    ██╗  █████╗  ███╗   ███╗
    ██║ ██╔══██╗ ████╗ ████║
    ██║ ███████║ ██╔████╔██║
██  ██║ ██╔══██║ ██║╚██╔╝██║
╚████╔╝ ██║  ██║ ██║ ╚═╝ ██║
 ╚═══╝  ╚═╝  ╚═╝ ╚═╝     ╚═╝
</pre>

# jam

**Cross-language code intelligence for polyglot codebases.**

Trace call graphs and column-level impact across Java, SQL, Python, and TypeScript.
From your terminal — or as an MCP server for any AI agent.

[![CI](https://github.com/sunilp/jam-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/sunilp/jam-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@sunilp-org/jam-cli.svg)](https://www.npmjs.com/package/@sunilp-org/jam-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Docs](https://jam.sunilprakash.com) · [Install](#install) · [VSCode Extension](https://marketplace.visualstudio.com/items?itemName=sunilp.jam-cli-vscode)

</div>

---

## The pain jam solves

You're about to drop the `legacy_id` column from `customer`. Your codebase has Java services, Python ETL jobs, raw SQL stored procs, and a TypeScript frontend. Your AI agent searches for the column name and finds 3 references. Are there really only 3? Or did the agent miss the JPA `@Column(name="legacy_id")` mapping, the MyBatis XML alias, the SQLAlchemy column class, and the stored procedure that joins on it?

```bash
jam impact customer.legacy_id
```

```
customer.legacy_id
├─ Java (5 callers)
│  ├─ CustomerRepository.findByLegacyId       src/main/java/.../CustomerRepository.java:42
│  ├─ CustomerService.migrate (uses #1)       src/main/java/.../CustomerService.java:118
│  └─ ... 3 more
├─ Python (2 callers)
│  ├─ etl.transform_customers                 etl/transforms.py:67
│  └─ migrations/0042_drop_column.py          (drops the column ← intended)
├─ SQL (3 callers)
│  ├─ sp_reconcile_customers (stored proc)    db/procs/sp_reconcile_customers.sql:12
│  ├─ vw_customer_audit (view)                db/views/vw_customer_audit.sql:8
│  └─ trigger_customer_audit                  db/triggers/trigger_customer_audit.sql:5
└─ TypeScript (1 caller)
   └─ getCustomerLegacy                       web/src/api/customer.ts:23

⚠ Risk: HIGH — 11 sites across 4 languages depend on this column.
```

That's the value. Run it before the change, not after CI breaks.

## What jam does

- **`jam trace <symbol>`** — call graph in any direction (callers, callees, both) across languages
- **`jam impact <symbol>`** — what breaks if this symbol or column changes
- **`jam diagram`** — Mermaid diagrams for architecture or call flow
- **`jam search`** / **`jam deps`** — symbol search and dependency analysis
- **`jam mcp serve`** *(Phase 2, coming)* — expose all of the above as an MCP server, so Claude Code, Cursor, Aider, and Goose can call into jam's polyglot intelligence
- **`jam agent "<task>"`** *(experimental)*: runs a coding-agent loop, then decides completion with a deterministic verifier instead of the model's own claim. Policy-mediated, journalled, resumable. Does not use the cross-language graph yet. [Details below](#jam-agent-experimental).
- Plus a handful of zero-LLM developer utilities: `ports`, `stats`, `hash`, `json`, `env`, `dup`, `http`, `todo`, `git wtf`, `git undo`, `git standup`, and more

## What jam is **not**

- Not an AI coding agent. Use Claude Code, Cursor, or Aider for "write this feature." The exception is `jam agent`, which does run a coding loop, but it is not competing on how well it writes code. It competes on who gets to decide the work is finished. Read its [limitations](#jam-agent-experimental) before trusting the answer.
- Not a chat tool. Use the official Anthropic, OpenAI, or Google CLIs for that.
- Not a generic terminal AI. jam answers one question well: *"if I change this, what breaks across my stack?"*

## Install

```bash
# npm
npm install -g @sunilp-org/jam-cli

# Homebrew
brew tap sunilp/tap && brew install jam-cli

# Try without installing
npx @sunilp-org/jam-cli doctor
```

## Quickstart

```bash
jam doctor                       # check your environment
jam trace getUserById            # who calls / what does it call
jam impact users.email           # cross-language column impact
jam diagram --type architecture  # Mermaid architecture diagram
jam agent "make src/foo.test.ts pass"   # experimental, Node 22.5+
```

## `jam agent` (experimental)

A coding-agent harness: give it a task, it runs a tool-calling loop against
your configured model, and it decides completion with a deterministic
verifier rather than trusting the model's own claim. `COMPLETED_VERIFIED` is
not a thing the model can emit. It is computed from exit codes, and it is
unreachable if you declared nothing to verify. Every tool call goes
through a policy reference monitor (auto-allow, ask, or deny) and is recorded
in an append-only session journal, so a run is auditable and resumable.

Reach for it when a run is unattended and an unverified "done" is expensive: CI, batch
fixes, anything where nobody is going to read the transcript. For interactive work where
you are watching anyway, Claude Code is the better tool.

```bash
jam agent "make the failing test in src/foo.test.ts pass"
jam agent --json "..." > run.jsonl   # headless mode, one JSON event per line
```

Declare what must pass in `.jam/config.yaml`:

```yaml
verification:
  required:
    - command: npm test
    - gitDiffCheck: true
```

Exit codes (see `exitCodeFor` in `src/commands/agent.ts`):

| Code | Meaning |
|---|---|
| `0` | `COMPLETED_VERIFIED` — every declared requirement ran and passed |
| `1` | `COMPLETED_PARTIAL` (retries exhausted) or `FAILED` |
| `3` | `COMPLETED_UNVERIFIED` — nothing was declared to verify |
| `4` | stopped (cancelled, or a tool-call/token/time budget ran out) |

A denied or escalated tool call is not a separate exit code: the policy
engine's decision is fed back to the model as a recoverable tool result, and
only changes the outcome insofar as it changes what the model does next —
which may still end in any of the states above.

Requires **Node 22.5+** (it stores session history via the built-in
`node:sqlite` module); every other jam command still runs on Node 20.
`jam agent` fails fast with an actionable message on an older runtime rather
than crashing.

**Verification runs exactly the commands you declare** — it does not
independently confirm what those commands mean. A requirement's command is
frozen as text at session start, not what it resolves to, so an agent that
edits a file the command depends on (for example `package.json`'s
`scripts.test`) can still make a verified command report success. Treat
`COMPLETED_VERIFIED` as "the commands you named ran and exited zero," not as
an independent guarantee of correctness.

## Status

- **Unreleased**: `jam agent`, the coding-agent harness described above. It sits beside the roadmap rather than in it: it needs Node 22.5+, it does not touch the trace path, and it does not delay `jam mcp serve`.
- **v0.12.0** (current) — Sharp pivot from generic AI CLI to cross-language code intelligence. AI-assistant features (ask/chat/run/go and friends) archived to [`archive/ai-suite`](https://github.com/sunilp/jam-cli/tree/archive/ai-suite).
- **v0.13** (next) — `jam mcp serve` stdio MCP server. Plug jam into Claude Code / Cursor / Aider / Goose.
- **v0.14** (after that) — Deep Java (Spring Data, JPA, MyBatis), Python (SQLAlchemy, Django, Alembic), SQL (multi-dialect, views, triggers, stored procs), and Kotlin support.

## Looking for ask / chat / run / go?

Those commands were removed in v0.12. They competed with Claude Code without doing anything Claude Code doesn't already do better. The code was archived rather than deleted, on [`archive/ai-suite`](https://github.com/sunilp/jam-cli/tree/archive/ai-suite), because the plan was always to bring AI back once there was something worth bringing back.

`jam agent` is that return, and it is worth being precise about what it does and does not settle. The v0.12 test was whether jam could write code better than Claude Code. It could not, and it still cannot, which is why `ask`, `chat`, `run` and `go` are not coming back. `jam agent` answers a different question: who decides a run is finished. That is not the cross-language graph, which was the other condition set in v0.12 and is still unmet. Until `src/trace/` feeds working-set and test selection, `jam agent` is a generic harness with a strict completion contract, and nothing about it is polyglot. Judge it on the completion contract, not on the graph.

## License

MIT
