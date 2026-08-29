---
title: "Your AI CLI Writes Code. Mine Tells You What It'll Break."
published: false
description: "Claude Code and Gemini CLI are great at generating code. But ask them what breaks if you rename a function — and they'll guess. Jam uses static analysis to tell you exactly."
tags: ai, developer-tools, productivity, cli
canonical_url: https://jam.sunilprakash.com
cover_image: https://jam.sunilprakash.com/img/og-card.png
---

AI CLI tools are everywhere right now. Claude Code, Gemini CLI, GitHub Copilot in the terminal — they'll write your code, refactor your modules, even run your tests.

But ask any of them: **"If I rename this function, what breaks?"**

They'll scan the files they can see, make their best guess, and probably miss the SQL view that reads the column you're about to change. Or the Java batch job that calls your Python function through a stored procedure. Or the dbt model downstream of the table your migration is about to alter.

That's not a knock on AI. It's just not what LLMs are built for. Dependency analysis needs **deterministic static analysis**, not probabilistic text generation.

## The gap in every AI CLI

Here's what I noticed building with these tools: they're incredible at *writing* code but terrible at *understanding what already depends on it*.

Ask Claude Code to "add retry logic to the HTTP client" — brilliant. Ask it "what will break if I change the response shape of `getUser`" — it'll read a few files and give you a confident answer that misses half the callers.

That's because LLMs work with whatever fits in context. Your codebase has thousands of files. The SQL stored procedure that calls your function through `EXEC` isn't in the context window.

## Static analysis that crosses language boundaries

I built [Jam](https://jam.sunilprakash.com) to fill this gap. It's a developer CLI with 40+ commands, but the one that keeps saving me is `jam trace --impact`.

It uses tree-sitter to parse your entire workspace — TypeScript, Python, Java, and SQL — builds a SQLite index of every function, every call site, every import, and every SQL column reference. Then gives you a deterministic answer:

```bash
$ jam trace updateBalance --impact

Impact Analysis for updateBalance
───────────────────────────────────
Direct callers:
  PaymentService.processRefund()  [Java]
  BATCH_NIGHTLY_RECONCILE         [SQL]

Column dependents:
  VIEW v_customer_summary   (reads customer.balance)
  PROC_MONTHLY_STATEMENT    (reads customer.balance)

Risk: HIGH — 2 callers across 2 languages, 2 column dependents
```

No hallucination. No "I think these files might be affected." Two callers in two languages, two column dependents, risk level HIGH. Deterministic.

## Why LLMs can't do this (yet)

1. **Context window limits** — Your 200-file Java project with SQL migrations doesn't fit in any context window. Static analysis indexes everything.

2. **Cross-language boundaries** — A Java class running `EXEC update_user` is calling a SQL stored procedure. LLMs see a string. Tree-sitter sees a cross-language call.

3. **Column-level tracking** — When a SQL view reads `customer.balance`, and your function writes to `customer.balance`, that's a dependency. No LLM tracks this.

4. **Determinism** — Ask an LLM the same question twice, get different answers. Ask `jam trace` twice, get the same graph. For impact analysis, you need guarantees, not guesses.

## Not replacing AI — complementing it

Jam isn't anti-AI. It literally has AI built in — `jam ask`, `jam go` (agentic execution), `jam commit` (AI-powered commit messages), `jam review`. It works with Ollama, Copilot, OpenAI, Anthropic, and Groq.

But for the question "what breaks if I change this?" — AI is the wrong tool. You wouldn't ask ChatGPT to run your test suite. You shouldn't ask it to trace your dependency graph either.

The best workflow: use Claude Code or Gemini CLI to *write* the change, then use `jam trace --impact` to *verify* the blast radius before you ship.

```bash
# Trace any symbol's callers and callees
jam trace createProvider --depth 5

# Get the full impact report
jam trace updateBalance --impact

# Output as Mermaid diagram for docs
jam trace handleRequest --mermaid

# JSON for CI/automation
jam trace processPayment --impact --json
```

## How it works

1. **Tree-sitter parsing** — Builds ASTs for TypeScript, Python, Java, SQL
2. **Symbol extraction** — Functions, classes, methods, imports, call sites
3. **Cross-language detection** — Java `EXEC`/`CALL` → SQL procedures. SQL column refs in SELECT/UPDATE/INSERT/DELETE
4. **SQLite index** — Local database, fast graph queries, incremental updates
5. **Impact analysis** — Walks the graph upstream, finds column dependents, calculates risk

The index rebuilds in seconds. No cloud. No API calls. Pure local static analysis.

## Try it

```bash
npm install -g @sunilp-org/jam-cli
jam trace <any-function-name>
jam trace <any-function-name> --impact
```

No API key needed for trace — it's pure static analysis. The AI features (ask, go, commit, review) auto-detect your provider.

978 tests. MIT licensed. Works everywhere Node runs.

---

[GitHub](https://github.com/sunilp/jam-cli) | [Website](https://jam.sunilprakash.com) | [npm](https://www.npmjs.com/package/@sunilp-org/jam-cli) | [VSCode Extension](https://marketplace.visualstudio.com/items?itemName=sunilp.jam-cli-vscode)
