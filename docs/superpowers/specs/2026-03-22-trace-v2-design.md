# jam trace v2 — Universal Code Archaeology Tool

## Goal

Replace jam trace's regex-based call graph engine with a tree-sitter + LLM hybrid that provides accurate call graphs, cross-language tracing, data lineage, and impact analysis across any codebase — including legacy SQL, PL/SQL, and COBOL systems with 100k+ files.

## Use Cases

1. **Modernization teams** — understand "what calls what" before refactoring or rewriting legacy systems
2. **Maintenance teams** — trace impact of changes ("if I modify this procedure, what breaks?")
3. **Audit/compliance** — data lineage and control flow for regulatory purposes ("every path that touches CUSTOMER_BALANCE")
4. **Agent engine** — jam go/run use the trace index to understand workspace before modifying code

## Phasing

This is a large feature. It is split into two phases:

- **Phase 1** (this spec): Tree-sitter parsing, SQLite index, call graph engine, cross-language tracing, impact analysis. Languages: TypeScript, JavaScript, Python, SQL, Java.
- **Phase 2** (separate spec): Data lineage, PL/SQL extractor, COBOL extractor, Go/Rust/C# extractors, agent engine integration.

Phase 2 depends on Phase 1 infrastructure being stable.

## Architecture

Three-layer system:

### Layer 1: Parser Layer (tree-sitter)

Parses source files into ASTs per language. Extracts symbols, calls, imports, column references, and type annotations. Output is a structured SymbolIndex stored on disk in `.jam/trace-index/`.

Tree-sitter provides:
- Real AST parsing (no regex false positives)
- 40+ language grammars maintained by the community
- Millions of lines per second, runs locally, no API costs
- Node.js bindings via `tree-sitter` npm package

### Layer 2: Graph Engine (pure logic)

Queries the index to build call graphs, upstream/downstream chains, and data lineage. Handles cross-language edges (Java → SQL proc). Scales to 100k+ files via indexed SQLite lookups instead of full file scans. Supports configurable depth with no hardcoded cap.

### Layer 3: Semantic Analyzer (LLM)

Receives the focused subgraph (not entire codebase). Produces impact analysis reports and intent summaries. Called once per trace command, not per file. Uses the configured AI provider. Token budget: subgraph is truncated to 8000 tokens max before sending to LLM; if the graph exceeds this, only the immediate callers/callees and a summary of deeper nodes are included.

## Native Dependency Strategy

`tree-sitter` and its grammar packages are native addons requiring C compilation or prebuild binaries.

**Strategy: optional dependency with graceful fallback.**

- `tree-sitter` and bundled grammars are listed as `optionalDependencies` in `package.json`.
- If they fail to install (no C toolchain), jam falls back to the existing regex-based `call-graph.ts` engine with a warning: "Tree-sitter not available — using basic regex engine. Install a C toolchain for full trace support."
- Prebuild binaries are available for most platforms via the grammar packages themselves (they ship `prebuildify` artifacts).
- Homebrew tap and VSCode extension bundle prebuilt binaries — no user-side compilation needed.
- CI: GitHub Actions runners have C toolchains by default.

## Language Support

### Phase 1 — Bundled grammars (full call graph + impact):
- TypeScript/JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`) — `tree-sitter-typescript`
- Python (`.py`) — `tree-sitter-python`
- SQL (`.sql`) — `tree-sitter-sql` (evaluate grammar quality; if insufficient, use hybrid regex+AST for SQL-specific constructs like CREATE PROCEDURE/VIEW)
- Java (`.java`) — `tree-sitter-java`

### Phase 2 — On-demand install:
- PL/SQL (`.pls`, `.pkb`, `.pks`, `.plb`) — no mature npm grammar exists; Phase 2 will either use a forked grammar or regex-based extraction via the existing `src/intel/analyzers/sql.ts` patterns
- COBOL (`.cob`, `.cbl`, `.cpy`) — `tree-sitter-cobol` is 0.0.1; Phase 2 will validate against real COBOL before committing, with regex fallback
- Go (`.go`), Rust (`.rs`), C# (`.cs`)

### On-demand grammar installation

When jam encounters a file extension requiring an uninstalled grammar:
1. Prompt: `Grammar for <lang> not installed. Install? [Y/n]`
2. Install to project-local `node_modules` via `npm install tree-sitter-<lang>`
3. If user declines or install fails (offline/air-gapped), fall back to regex engine for that language
4. Grammars are cached in `node_modules` and reused on subsequent runs

## Per-Language Extractors

Each language gets an extractor module (~100-200 lines) that maps tree-sitter AST node types to a universal Symbol schema. Extractor source code is always bundled; only grammar binaries are on-demand.

Extractor responsibilities:
- Walk specific AST node types for the language
- Emit `Symbol`, `CallRef`, `ImportRef`, and `ColumnRef` records
- Handle language-specific patterns (Java method invocation, SQL EXECUTE, Python decorator)

Extractors for each Phase 1 language:

| Language | Symbol nodes | Call nodes | Import nodes | Column nodes |
|----------|-------------|-----------|-------------|-------------|
| TypeScript | function_declaration, arrow_function, class_declaration, method_definition | call_expression, new_expression | import_statement, import_clause | — |
| Python | function_definition, class_definition | call, attribute (method call) | import_from_statement, import_statement | — |
| SQL | create_procedure, create_function, create_view, create_trigger | execute_statement, function_call | — | select_clause, insert_columns, update_set, delete_from |
| Java | method_declaration, class_declaration, constructor_declaration | method_invocation | import_declaration | — |

## Trace Index

Pre-built, incremental, stored on disk at `.jam/trace-index/`.

### Storage

`better-sqlite3` — mature, widely-used synchronous SQLite driver for Node.js. Ships prebuild binaries for all major platforms. No Node version requirement beyond the existing `>=20`.

Rationale: `node:sqlite` is experimental (Node 22.5+) and the project supports Node 20+. `better-sqlite3` is battle-tested, synchronous (simpler code), and fast.

### Schema

```sql
CREATE TABLE schema_version (version INTEGER NOT NULL);
-- Initial version: 1. On version mismatch, drop all tables and rebuild.
-- The index is a cache — rebuilding is always safe.

CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,        -- function, method, class, procedure, paragraph, view, trigger
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  end_line INTEGER,
  signature TEXT,
  return_type TEXT,
  body_hash TEXT,            -- for change detection
  language TEXT NOT NULL
);

CREATE TABLE calls (
  id INTEGER PRIMARY KEY,
  caller_id INTEGER REFERENCES symbols(id),
  callee_name TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  arguments TEXT,            -- JSON array of argument expressions
  kind TEXT DEFAULT 'direct' -- direct, cross-language, dynamic
);

CREATE TABLE imports (
  id INTEGER PRIMARY KEY,
  file TEXT NOT NULL,
  symbol_name TEXT NOT NULL,
  source_module TEXT NOT NULL,
  alias TEXT
);

CREATE TABLE columns (
  id INTEGER PRIMARY KEY,
  symbol_id INTEGER REFERENCES symbols(id),
  table_name TEXT NOT NULL,
  column_name TEXT NOT NULL,
  operation TEXT NOT NULL     -- SELECT, INSERT, UPDATE, DELETE
);

CREATE TABLE files (
  path TEXT PRIMARY KEY,
  mtime_ms INTEGER NOT NULL,  -- for incremental updates
  language TEXT NOT NULL
);

CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_calls_callee ON calls(callee_name);
CREATE INDEX idx_calls_caller ON calls(caller_id);
CREATE INDEX idx_columns_table ON columns(table_name, column_name);
CREATE INDEX idx_imports_symbol ON imports(symbol_name);
```

### Schema Migration

The `schema_version` table stores the current version (initially 1). On startup, `store.ts` checks this version against the expected version in code. On mismatch, all tables are dropped and the index is rebuilt from scratch. This is acceptable because the index is a cache — no user data is lost.

### Index Lifecycle

- `jam trace foo` → checks if index exists and is fresh → uses it
- `jam trace --reindex` → forces full rebuild
- `jam run` / `jam go` → uses index if available for workspace understanding (Phase 2)
- Stale entries auto-rebuild: files re-parsed when `mtime` is newer than last index time
- First run in a new workspace: full build

### Performance Targets (aspirational, validated by performance tests)

- Initial index build: target ~5 seconds for 10k files
- Incremental update: <1 second (only changed files)
- Query "all callers of X, depth 10": <100ms from index

## Cross-Language Tracing

The `calls` table stores callee names as strings, not resolved IDs. The graph engine resolves them at query time.

### Cross-language edge resolution

Name matching uses these rules to avoid false positives:
1. **Exact match required** — no partial/substring matching
2. **Context-qualified** — a cross-language edge is only created when the call site uses a known cross-language pattern (e.g., `cursor.execute("CALL X")`, `callableStatement.execute("X")`)
3. **Extractors tag cross-language calls** with `kind: 'cross-language'` — the graph engine only does cross-language resolution for these tagged calls, not for all unresolved names
4. **Ambiguity reporting** — if multiple symbols match a cross-language callee name, all candidates are included with a `[ambiguous]` marker

### Cross-language edge detection patterns

| Source Language | Pattern | Target |
|---|---|---|
| Java | `callableStatement.execute("PROC_NAME")`, `@Procedure("PROC_NAME")` | SQL procedure |
| Python | `cursor.callproc("PROC_NAME")`, `cursor.execute("CALL PROC_NAME")` | SQL procedure |
| SQL | `EXEC PROC_NAME`, `CALL PROC_NAME`, `EXECUTE PROC_NAME` | Another procedure |
| Any | Table/column references in SQL | Links to other SQL touching same table |

### Column-level linking

When two procedures both reference `CUSTOMER.BALANCE`, the index links them through the `columns` table — even if they never call each other directly. This powers impact analysis without explicit call edges.

## Impact Analysis

Activated with `--impact` flag. Available in Phase 1.

1. Builds full upstream + downstream call graph from index
2. Finds all column dependencies from `columns` table
3. Finds views and triggers referencing the same tables
4. LLM produces a structured impact report

Example output for `jam trace PROC_UPDATE_BALANCE --impact`:
```
Impact Analysis for PROC_UPDATE_BALANCE
═══════════════════════════════════════

Direct callers (break if signature changes):
  → PaymentService.processRefund() [Java] (line 142)

Column dependents (affected if table structure changes):
  → VIEW v_customer_summary (reads customer.balance)
  → PROC_MONTHLY_STATEMENT (reads customer.balance)

Trigger chain:
  → TRG_CUSTOMER_AUDIT fires on UPDATE customer

Risk: MEDIUM — 1 direct caller, 2 column dependents, 1 trigger.
```

## Data Lineage (Phase 2)

Activated with `--data-lineage` flag. Deferred to Phase 2 because it requires column-level tracking to be validated against real SQL/PL-SQL codebases.

Planned behavior:
1. Finds all columns the traced symbol touches (from `columns` table)
2. Finds all OTHER symbols touching the same columns
3. Builds a data flow graph: READ → TRANSFORM → WRITE
4. LLM summarizes the flow in natural language

## CLI Interface

```
jam trace [symbol]
  --depth <n>       upstream chain depth (default: 10, increased from 3;
                    deeper traversal is feasible with SQLite-backed queries)
  --lang <lang>     override file extension-based language detection for
                    the file containing the symbol (e.g., --lang plsql
                    for a .sql file that contains PL/SQL)
  --impact          show what breaks if symbol changes
  --data-lineage    trace column/variable flow (Phase 2)
  --reindex         force rebuild of trace index
  --no-ai           skip LLM semantic analysis
  --json            output as structured JSON (instead of default ASCII tree)
  --mermaid         output as Mermaid diagram (instead of default ASCII tree)
  + global options: --profile, --provider, --model, --base-url, --quiet
```

Default output: ASCII tree (same as current). `--mermaid` and `--json` are alternative output modes (mutually exclusive with ASCII tree).

## Error Handling

- **Tree-sitter parse failure** (syntax errors, unsupported constructs): log warning, skip file, continue indexing. Partial indexes are valid — missing files are reported at trace time.
- **SQLite corruption**: detect on open, delete and rebuild automatically.
- **LLM call failure** (rate limit, network): display the structural trace (call graph, impact) without the AI narrative. Print: "AI analysis unavailable — showing structural results only."
- **Symbol not found**: search for close matches (case-insensitive, prefix), suggest candidates.
- **Very large codebases** (500k+ files): index in batches, show progress bar. No hard cap — SQLite handles millions of rows.

## Relationship to Intel Module

The existing `src/intel/` module and the new `src/trace/` module serve different purposes:

- **Intel**: broad codebase scanning — architecture patterns, dependency analysis, convention detection. Uses `AnalyzerPlugin` interface, stores results as `IntelNode`/`IntelEdge` in JSON.
- **Trace**: deep symbol-level analysis — call graphs, data flow, impact. Uses tree-sitter extractors, stores in SQLite.

They coexist. In Phase 2, `workspace-intel.ts` will query the trace index to enrich the workspace profile with symbol-level data. The intel analyzers for SQL and COBOL (`src/intel/analyzers/sql.ts`, `cobol.ts`) serve as fallback extractors when tree-sitter grammars are unavailable.

## File Structure

```
src/trace/
  index.ts              → public API: buildIndex(), querySymbol(), traceCallGraph()
  parser.ts             → tree-sitter wrapper: parse file → AST
  indexer.ts            → walks AST via extractors → writes to SQLite
  store.ts              → SQLite read/write, incremental updates, schema migration
  graph.ts              → builds call graph from index
  impact.ts             → impact analysis (upstream + downstream + columns)
  formatter.ts          → ASCII tree, Mermaid, JSON output
  extractors/
    base.ts             → ExtractorInterface + shared utilities
    typescript.ts
    python.ts
    java.ts
    sql.ts
```

Phase 2 adds: `lineage.ts`, `extractors/plsql.ts`, `extractors/cobol.ts`, `extractors/go.ts`, `extractors/rust.ts`.

### Modified files
- `src/commands/trace.ts` → rewire to use `src/trace/index.ts` instead of `call-graph.ts`

### Phase 2 modifications
- `src/agent/workspace-intel.ts` → query trace index for symbol context
- `src/agent/worker.ts` → query index before modifying code

### Deprecated (after Phase 1 is stable)
- `src/utils/call-graph.ts` → replaced by `src/trace/graph.ts`

### New dependencies
- `better-sqlite3` — SQLite driver (required)
- `tree-sitter` — core parser runtime (optionalDependency)
- `tree-sitter-typescript` — bundled (optionalDependency)
- `tree-sitter-python` — bundled (optionalDependency)
- `tree-sitter-sql` — bundled (optionalDependency)
- `tree-sitter-java` — bundled (optionalDependency)

## Migration Path

1. Build new `src/trace/` module alongside existing `call-graph.ts`
2. Wire `jam trace` to new engine; if tree-sitter unavailable, fall back to old engine
3. Validate against real codebases, fix extractors
4. Mark old `call-graph.ts` as deprecated
5. Phase 2: integrate index into agent engine, add remaining languages

## Testing Strategy

- **Unit tests per extractor**: parse known code snippets, verify extracted symbols/calls/columns
- **Store tests**: schema creation, incremental updates, migration (version mismatch → rebuild)
- **Graph tests**: build index from multi-language fixture (Java + SQL), trace symbol across languages
- **Integration test**: `jam trace PROC_NAME --impact` on a fixture codebase, verify output
- **Fallback test**: verify regex engine is used when tree-sitter is not installed
- **Performance test**: index 10k files, measure build time (target: <5 seconds)
- **Error handling tests**: corrupt SQLite file, unparseable source file, symbol not found
