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
- Plus a handful of zero-LLM developer utilities: `ports`, `stats`, `hash`, `json`, `env`, `dup`, `http`, `todo`, `git wtf`, `git undo`, `git standup`, and more

## What jam is **not**

- Not an AI coding agent. Use Claude Code, Cursor, or Aider for "write this feature."
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
```

## Status

- **v0.12.0** (current) — Sharp pivot from generic AI CLI to cross-language code intelligence. AI-assistant features (ask/chat/run/go and friends) archived to [`archive/ai-suite`](https://github.com/sunilp/jam-cli/tree/archive/ai-suite).
- **v0.13** (next) — `jam mcp serve` stdio MCP server. Plug jam into Claude Code / Cursor / Aider / Goose.
- **v0.14** (after that) — Deep Java (Spring Data, JPA, MyBatis), Python (SQLAlchemy, Django, Alembic), SQL (multi-dialect, views, triggers, stored procs), and Kotlin support.

## Looking for ask / chat / run / go?

Those commands were removed in v0.12 — they competed with Claude Code without doing anything Claude Code doesn't already do better. The code lives on the [`archive/ai-suite`](https://github.com/sunilp/jam-cli/tree/archive/ai-suite) branch. A future release may revive AI features, but only ones that ride on top of the cross-language graph (impact-aware migration plans, PR-tailored impact summaries, etc.) — not generic chat.

## License

MIT
