# jam intel — Codebase Intelligence

**Date:** 2026-03-18
**Status:** Design reviewed, pending implementation plan

## Overview

`jam intel` is a codebase intelligence feature that analyzes entire repositories (or multiple repos) to build a semantic knowledge graph — understanding not just what code exists, but what it does, why it exists, and how changing one thing affects everything else. It provides interactive visual exploration through a VSCode sidebar panel and a full browser-based graph explorer with natural language querying.

### What makes it different

- **Understands intent, not just structure** — LLM-enriched nodes carry purpose, domain, pattern, and risk metadata. "This is the authentication middleware" vs "these files import each other."
- **Multi-repo, multi-language** — links services across repositories, including legacy systems (COBOL) alongside modern stacks.
- **Always current** — incremental re-scan detects changes via mtime (v1), file watcher keeps graph in continuous sync (v2). No stale architecture docs.
- **Architecture diagram first** — initial scan immediately produces a visual architecture diagram before any LLM enrichment. The diagram upgrades in place as semantic understanding deepens.
- **Queryable** — natural language queries answered against the graph with visual responses.

## Relationship to Existing Code

jam-cli already has analysis infrastructure that `jam intel` builds on:

| Existing | Reuse in jam intel |
|----------|-------------------|
| `src/analyzers/imports.ts` — import graph builder (regex-based, cycle detection via Tarjan's) | Extend as the TS/JS import analyzer plugin. Add export tracking. |
| `src/analyzers/structure.ts` — project structure analyzer (module grouping, symbol extraction, hotspot detection) | Reuse for the structural scan phase. Feed its `ProjectAnalysis` output into the knowledge graph. |
| `src/analyzers/types.ts` — `Graph`, `ModuleInfo`, `SymbolInfo`, `ProjectAnalysis` types | Extend with new node/edge types for the knowledge graph. Maintain backwards compatibility. |
| `src/utils/call-graph.ts` — call graph builder (definition finding, reference tracking, Mermaid output) | Reuse for `calls` edge extraction. Extend Mermaid output for architecture diagrams. |
| `src/commands/diagram.ts` — Mermaid diagram generation | `jam intel diagram` delegates to this with richer graph data. `jam diagram` becomes an alias. |
| `src/commands/stats.ts` — LOC, languages, complexity, git churn | Reuse git churn data for LLM enrichment prioritization (most-changed files first). |

**Migration path for `jam diagram`:** `jam diagram` will remain as a standalone command for quick one-shot diagrams. `jam intel diagram` generates richer diagrams from the knowledge graph. Over time, `jam diagram` can optionally read from the intel graph if one exists, falling back to its current behavior.

## Architecture

### System Pipeline

```
Source Repos → Static Analyzers → LLM Enrichment → Knowledge Graph → Consumers
```

**Static Analyzers** (offline, seconds): Extend existing `src/analyzers/` with pluggable language analyzers. Builds the structural skeleton and immediately generates architecture diagram.

**LLM Enrichment** (background, progressive): Adds semantic metadata to every node. Prioritized by connectivity × change frequency. Optional — can be skipped with `--no-enrich`.

**Knowledge Graph**: Hybrid storage — JSON on disk (`.jam/intel/` directory per repo), in-memory graph at runtime for fast querying. Portable, no database dependency.

**Consumers**: CLI (v1), browser explorer with Mermaid (v1), interactive browser app (v2), VSCode sidebar panel (v2), Copilot Chat (v2).

### Data Model

#### Nodes

Every entity in the codebase is a node:

| Type | Description |
|------|-------------|
| `repo` | A git repository |
| `service` | A deployable unit / application |
| `module` | A package / directory boundary |
| `file` | A source file |
| `class` / `function` | Code entities |
| `endpoint` | API route (REST, gRPC, GraphQL) |
| `table` / `schema` | Database entities |
| `queue` / `event` | Async boundaries |
| `config` | Env vars, feature flags |
| `external` | 3rd party services / APIs |

#### Edges

Relationships between nodes:

| Type | Description |
|------|-------------|
| `imports` | Code dependency |
| `calls` | Runtime invocation |
| `reads` / `writes` | Data access |
| `publishes` / `subscribes` | Event flow |
| `exposes` / `consumes` | API contract |
| `contains` | Structural hierarchy |
| `configures` | Config dependency |
| `deploys-with` | Infrastructure relationship |

#### Semantic Metadata (LLM-generated, per node)

| Field | Description |
|-------|-------------|
| `purpose` | What it does, in plain English |
| `pattern` | Architectural pattern detected |
| `domain` | Business domain it belongs to |
| `risk` | Change risk assessment |
| `summary` | Natural language description |
| `connections` | Semantic links static analysis can't see |

## Analysis Pipeline

### Phase 1: Instant Structural Scan (seconds, offline)

No LLM needed. Reuses existing analyzers (`src/analyzers/imports.ts`, `src/analyzers/structure.ts`, `src/utils/call-graph.ts`). Builds the skeleton graph and immediately generates an architecture diagram.

**Extracts:**
- File tree and language detection (reuse from `jam stats`)
- Import graph and exports / public API (extend `src/analyzers/imports.ts`)
- Class and function signatures (extend `src/analyzers/structure.ts`)
- Call graph (reuse `src/utils/call-graph.ts`)
- Database schemas (SQL migrations, ORM models) — new analyzer
- API routes (Express route detection) — new analyzer
- Package manifests (package.json, requirements.txt, pom.xml, etc.) — new analyzer
- Docker / docker-compose configuration — new analyzer
- Environment variable references — new analyzer

**Immediate output:**
- Architecture diagram generated from structural data (Mermaid format, opens in browser via static HTML + Mermaid.js)
- Graph is queryable via CLI immediately
- Mermaid diagram saved to `.jam/intel/architecture.mmd`

### Phase 2: Progressive LLM Enrichment (background, minutes)

Runs in background while the user explores the structural graph. Nodes are enriched in priority order:

1. **Priority 1** — Entry points, high-connectivity hubs, most-changed files (via git churn from `jam stats`)
2. **Priority 2** — Service boundaries, API layers, database access patterns
3. **Priority 3** — Internal modules, utilities, tests, leaf nodes

As enrichment progresses:
- Architecture diagram upgrades in place with semantic labels, domain groupings, purpose annotations
- Flow diagrams are generated (data flow, request lifecycle, event flow)
- API dependency maps appear
- Cross-repo interaction diagrams surface (v2)

**Per node, the LLM generates:** purpose label, domain tag, pattern detection, risk score, plain-English summary, semantic edges (relationships static analysis missed).

**Enrichment depth levels:**
- `--enrich=shallow` — summary and purpose only (~100 tokens/node)
- `--enrich=deep` — full metadata including risk, patterns, semantic edges (~400 tokens/node)
- `--no-enrich` — structural graph only, no LLM calls

### Phase 3: File Watcher — Continuous Sync (v2)

Deferred to v2. In v1, users re-run `jam intel scan` to update the graph (incremental — only re-analyzes changed files based on mtime comparison).

In v2, the file watcher:
- Runs as a background process started by `jam intel watch` or by the VSCode extension
- Debounces rapid saves (500ms window)
- Watches via `chokidar` or Node.js `fs.watch` (not polling)
- On file change → re-parse that file, update graph edges, queue for LLM re-enrichment
- On branch switch (detected via `.git/HEAD` change) → diff file tree, batch-update
- Persists via the VSCode extension host process (not a standalone daemon)
- Lock file (`.jam/intel/.lock`) prevents concurrent writes from multiple terminals

### Language Support — Pluggable Analyzers

Each language gets an analyzer plugin implementing an `Analyzer` interface:

```typescript
interface Analyzer {
  languages: string[];           // e.g., ['typescript', 'javascript']
  extensions: string[];          // e.g., ['.ts', '.tsx', '.js', '.jsx']
  analyze(file: string): Node[]; // Extract nodes from a file
  edges(nodes: Node[]): Edge[];  // Compute edges between nodes
}
```

**v1 (Launch):** TypeScript/JavaScript (extend existing `src/analyzers/`), Python, COBOL, SQL (migrations/schemas), Docker/docker-compose, OpenAPI/Swagger

**v2 (Expand):** Java, Go, Rust, C#/.NET, Ruby, Terraform/Kubernetes, GraphQL

**v3 (Community):** Plugin API for custom analyzers (`jam plugin create --analyzer`)

Note: v1 Python and COBOL analyzers will use regex-based extraction (similar to existing TS/JS approach in `src/analyzers/imports.ts`), not full AST parsing. This gives 80% coverage with manageable effort. AST-based parsing can be added per-language in subsequent versions.

### Framework & Tool Intelligence

Analyzers don't just parse language syntax — they detect frameworks, libraries, and tools and understand their semantic patterns. During the structural scan, the scanner identifies framework markers (config files, directory conventions, import patterns) and activates framework-specific intelligence.

**How it works:** The scan detects framework markers (e.g., `dbt_project.yml` → dbt, `dag` directory with `@dag` decorators → Airflow, `app.use()` calls → Express middleware). Each framework has a knowledge profile that tells the analyzer what patterns to look for and what semantic relationships they imply.

**v1 Framework Profiles:**

| Framework / Tool | Detected by | Understands |
|-----------------|-------------|-------------|
| **dbt** | `dbt_project.yml`, `models/` dir | Source→staging→mart flow, `ref()` / `source()` DAG, transformation lineage, data warehouse modeling patterns |
| **Apache Airflow** | `dags/` dir, `@dag` / `@task` decorators | DAG orchestration, task dependencies, operator types, schedule intervals, sensor triggers |
| **Apache Spark / PySpark** | `SparkSession` imports, `.read` / `.write` chains | Transformation flow (read→transform→write), data sources/sinks, partition strategies |
| **Express.js** | `express()`, `app.use()`, `Router()` | Middleware chain, route→handler mapping, error handlers, static serving |
| **Django** | `settings.py`, `urls.py`, `models.py` | Models→views→urls→templates pattern, ORM relationships, middleware stack, admin registrations |
| **Flask** | `Flask(__name__)`, `@app.route` | Route→handler, blueprint structure, SQLAlchemy models if present |
| **React** | `package.json` deps, `.tsx`/`.jsx` files | Component tree, state management (Redux/Zustand/Context), route structure (React Router), data fetching patterns |
| **Spring Boot** | `pom.xml` with spring-boot, `@Controller` | Controller→service→repository layers, bean dependency injection, entity relationships (v2) |
| **SQLAlchemy** | `declarative_base()`, `Column()` imports | Table relationships, foreign keys, migration chain (Alembic) |
| **Prisma** | `schema.prisma` | Data model, relations, migration history |
| **Docker Compose** | `docker-compose.yml` | Service topology, network links, volume mounts, dependency ordering |
| **Kafka / Event Streaming** | Producer/consumer imports, topic configs | Publish→subscribe topology, topic→consumer group mapping, event schemas |
| **CICS / DB2 (COBOL)** | `EXEC CICS` / `EXEC SQL` statements | Transaction flow, BMS map screens, DB2 table access, COMMAREA structures |

**Framework detection output:** When a framework is detected, the scan:
1. Adds a `framework` metadata field to relevant nodes (e.g., `framework: 'dbt'`)
2. Creates framework-specific edges (e.g., dbt `ref()` calls become `depends-on` edges between models)
3. Generates framework-aware diagrams (e.g., dbt lineage as a transformation flow diagram, Airflow DAG as a task dependency diagram)
4. Labels nodes with framework-specific roles (e.g., "dbt staging model", "Airflow sensor task", "Express error middleware")

The LLM enrichment layer then builds on this — it understands the framework context and can answer questions like "show me the data transformation flow from raw sources to the analytics mart" or "what happens if this Airflow task fails?"

**Adding new framework profiles:** Framework profiles are declarative JSON files that specify detection markers, node patterns, edge patterns, and diagram templates. In v3, the plugin API allows community-contributed framework profiles (`jam plugin create --framework`).

### Mermaid Diagram Export

All diagram outputs support Mermaid format as the primary export, leveraging jam's existing Mermaid infrastructure (`src/utils/call-graph.ts`, `jam diagram`). Every view of the knowledge graph is exportable:

```
jam intel diagram                          # Architecture overview (default)
jam intel diagram --type flow              # Data / request flow diagram
jam intel diagram --type deps              # Dependency graph
jam intel diagram --type impact FILE       # Impact subgraph for a file
jam intel diagram --type framework         # Framework-specific (e.g., dbt lineage, Airflow DAG)
jam intel query "show auth flow" --mermaid # Export any query result as Mermaid
```

All `--mermaid` output can be piped to `jam md2pdf` or saved as `.mmd` files. The browser explorer (v1: static Mermaid.js page, v2: interactive) renders these natively. Framework-specific diagrams use appropriate Mermaid diagram types (flowchart for data pipelines, sequence diagrams for request flows, ER diagrams for data models).

### Multi-Repo — Workspace Manifest

Multiple repos are linked via an auto-generated workspace manifest:

```json
// .jam/intel/workspace.json
{
  "repos": [
    { "name": "api-service", "path": "../api-service" },
    { "name": "web-app", "path": "../web-app" },
    { "name": "legacy-batch", "path": "../legacy-batch" }
  ],
  "crossRepoEdges": []
}
```

**Lifecycle:** `jam intel scan --workspace ../a ../b ../c` creates the manifest with repo entries. `crossRepoEdges` starts empty. During LLM enrichment, the LLM discovers cross-repo connections (matching API contracts, shared types, event names, shared DB tables) and populates the edges automatically. Users can also manually add edges to the manifest. Subsequent scans preserve user-added edges and re-validate LLM-discovered ones.

Multi-repo scanning is a v2 feature. v1 focuses on single-repo analysis.

## Visualization & Query Layer

### v1: CLI Output + Mermaid Diagrams

**Architecture diagram:** Generated as Mermaid markup, rendered via a static HTML page bundled with Mermaid.js. `jam intel scan` opens this in the default browser. The HTML page auto-reloads when the `.mmd` file changes (simple file polling).

**Query output:** Text responses in the terminal, optionally with Mermaid diagram output (`--format mermaid`).

**Impact output:** Text list of affected files with risk levels (HIGH/MED/LOW), optionally with Mermaid subgraph.

### v2: Interactive Browser Explorer

A single-page application (likely using D3.js or Cytoscape.js) served from a local HTTP server (`jam intel explore`). Ships as bundled static assets within the npm package.

Features:
- Zoomable, pannable graph visualization
- Filter chips: All Repos, Services, Data Flow, API Layer, Database
- Natural language query bar
- Click node → detail panel (purpose, dependencies, risk, file links)
- Animated impact paths for query results
- Drill-down: click a service → see its internal modules → see individual files

### v2: VSCode Sidebar Panel + Extensions

Specified in a separate design document. Includes: sidebar tree view, context-aware right-click actions, auto-scan triggers, command palette entries, and Copilot Chat `@jam /intel` participant.

### Natural Language Queries

Four categories of queries:

**Explore:**
- "Show me the authentication flow"
- "What services does this project have?"
- "How does data get from the API to the database?"
- "Which COBOL programs share tables with the API?"

**Impact Analysis:**
- "What breaks if I rename the users table?"
- "What depends on the PaymentService class?"
- "If I change this API endpoint, who is affected?"
- "Show the blast radius of modifying COPYBOOK-01"

**Architecture:**
- "Explain this project to me like I just joined"
- "What patterns does this codebase use?"
- "Where are the service boundaries?"
- "Draw the request lifecycle for POST /orders"

**Find & Navigate:**
- "Where is user validation handled?"
- "Show all database access points"
- "Which files have the highest change risk?"
- "Find all event publishers and subscribers"

### Query Execution Model

1. **LLM parses query** using tool-use / function-calling pattern. The LLM receives the query + a schema of available graph operations (`findNode`, `getNeighbors`, `traversePath`, `filterByType`, `filterByDomain`). It returns a structured query plan.
2. **Graph engine executes** the plan against the in-memory graph. No LLM needed for traversal.
3. **LLM summarizes results** — receives the subgraph and generates a natural-language explanation with context.
4. **Output rendered** as text (CLI) or highlighted subgraph (browser explorer).

**Latency target:** < 5 seconds for most queries (one LLM call to parse, graph traversal is instant, one LLM call to summarize).

**Offline mode:** When no LLM is available, queries fall back to keyword matching against node names, types, and file paths. Results are structural only (no semantic interpretation). The `--no-ai` flag forces this mode.

## Configuration

New fields in `JamConfigSchema` (`src/config/schema.ts`):

```typescript
intel: {
  enrichDepth: 'shallow' | 'deep' | 'none',  // default: 'deep'
  maxTokenBudget: number,                      // default: 500000 (per scan)
  storageDir: string,                          // default: '.jam/intel'
  autoScan: boolean,                           // default: false (v2: true when file watcher enabled)
  excludePatterns: string[],                   // default: ['node_modules', 'dist', '.git', 'vendor']
  diagramFormat: 'mermaid',                     // default: 'mermaid' (more formats in v2)
  openBrowserOnScan: boolean,                  // default: true
}
```

## Storage & Scalability

### File Layout

```
.jam/intel/
├── graph.json          # Node and edge data (structural)
├── enrichment.json     # LLM-generated metadata (separate for easy regeneration)
├── architecture.mmd    # Latest architecture diagram (Mermaid)
├── workspace.json      # Multi-repo manifest (if applicable)
└── .lock               # Prevents concurrent writes
```

Structural data (`graph.json`) and LLM enrichment (`enrichment.json`) are stored separately so enrichment can be regenerated without re-scanning, and structural data remains useful without any LLM.

### Size Estimates

| Repo size | Nodes | graph.json | enrichment.json | Memory |
|-----------|-------|------------|-----------------|--------|
| Small (100 files) | ~500 | ~200KB | ~300KB | ~5MB |
| Medium (1000 files) | ~5,000 | ~2MB | ~3MB | ~30MB |
| Large (10,000 files) | ~50,000 | ~20MB | ~30MB | ~200MB |

For large repos (>5,000 nodes), the graph is sharded by module into separate JSON files under `.jam/intel/shards/`. The in-memory graph loads lazily — only the top-level module graph is loaded initially, with sub-module graphs loaded on drill-down.

**Gitignore:** `.jam/intel/` should be added to `.gitignore` by default. The enrichment data varies by model and is not reproducible. `jam intel scan` warns if the directory is not gitignored.

## Cost Model

### Token Estimates (per scan)

| Enrichment | Tokens/node | 500-file repo | 1000-file repo | 5000-file repo |
|------------|-------------|---------------|----------------|----------------|
| `shallow` | ~200 | ~100K | ~200K | ~1M |
| `deep` | ~600 | ~300K | ~600K | ~3M |

### Provider Considerations

| Provider | Practical limit | Notes |
|----------|----------------|-------|
| Ollama (local) | No token cost, but slow on large repos | Enrichment may take 10-30 min for 1000+ files |
| Copilot (via VSCode) | Free with subscription, rate limited | May need to throttle enrichment requests |
| Anthropic / OpenAI | Token cost applies | `maxTokenBudget` config enforced; scan stops enrichment when budget exhausted |
| Groq | Fast but rate limited | Good for shallow enrichment |

`jam intel scan` reports estimated token usage before starting enrichment. With `--dry-run`, it shows the estimate without starting.

## CLI Commands

```
jam intel scan                              # Scan current repo, generate architecture diagram
jam intel scan --no-enrich                  # Structural scan only, no LLM
jam intel scan --enrich=shallow             # Lighter LLM pass
jam intel scan --dry-run                    # Show scan estimate without running
jam intel scan --workspace ../a ../b        # Multi-repo scan (v2)
jam intel query "what handles auth?"        # Natural language query
jam intel query "auth" --no-ai              # Keyword-based structural query (offline)
jam intel impact src/models/user.ts         # Impact analysis for a specific file
jam intel explore                           # Open Mermaid diagram in browser (v1) / interactive explorer (v2)
jam intel diagram --format mermaid          # Export architecture diagram
jam intel status                            # Enrichment progress and graph stats
```

### Scan Output Behavior

```
$ jam intel scan
⚡ Structural scan... 247 files, 1,842 nodes, 3,291 edges (2.1s)
🏗️ Architecture diagram generated → opening in browser...
🧠 LLM enrichment started in background (est. ~150K tokens, 2-3 min)
💾 Saved to .jam/intel/graph.json
```

The architecture diagram is the hero artifact — generated immediately from structural data, opens in browser, and progressively upgrades as the LLM enriches nodes.

## Phasing Summary

### v1 — Core (this spec)

- Structural scan with pluggable analyzers (TS/JS, Python, COBOL, SQL, Docker, OpenAPI)
- Framework & tool intelligence (dbt, Airflow, Spark, Express, Django, Flask, React, SQLAlchemy, Prisma, Docker Compose, Kafka, CICS/DB2)
- Knowledge graph data model + JSON storage
- Progressive LLM enrichment with priority ordering and budget controls
- Architecture diagram (Mermaid) generated immediately on scan — the hero artifact
- Mermaid export for all diagram types (`--type flow`, `deps`, `impact`, `framework`) and query results (`--mermaid`)
- CLI commands: `scan`, `query`, `impact`, `explore`, `diagram`, `status`
- NL query via CLI with tool-use pattern
- Single-repo only

### v2 — Interactive + Multi-Repo

- Interactive browser explorer (D3/Cytoscape SPA)
- Multi-repo workspace manifest with cross-repo edge discovery
- File watcher for continuous sync
- VSCode sidebar panel, context menus, hover providers (separate spec)
- Copilot Chat `@jam /intel` participant (separate spec)
- Additional language analyzers (Java, Go, Rust, C#, Ruby)
- Additional framework profiles (Spring Boot, NestJS, FastAPI, Terraform, etc.)

### v3 — Community + Enterprise

- Plugin API for custom analyzers and framework profiles
- Terraform/Kubernetes infrastructure mapping
- Annotation layer (pin notes, tag ownership, save custom views)
- Team sharing (export/import knowledge graphs)
- GraphQL schema support

## Testing Strategy

### Fixtures

- **Small TS/JS fixture repo** (~20 files): Express API with routes, models, services, tests. Used for structural scan and enrichment tests.
- **Python fixture repo** (~15 files): Flask app with SQLAlchemy models. Tests Python analyzer.
- **COBOL fixture** (~10 programs): Batch jobs with COPYBOOK references and DB2 access. Tests COBOL analyzer.
- **Multi-language fixture** (~30 files): TS backend + Python ML service + SQL migrations. Tests cross-language edge detection.

### Test Categories

- **Static analyzers** (unit): Each analyzer tested against its fixture repo. Verify correct nodes, edges, and metadata extraction. Target: ~15 tests per analyzer.
- **Graph model** (unit): Node/edge CRUD, traversal algorithms, serialization/deserialization, sharding. Target: ~25 tests.
- **LLM enrichment** (unit, mocked): Prompt construction verified against snapshots. Response parsing with recorded LLM outputs. Budget enforcement tested. Target: ~15 tests.
- **Query layer** (integration): Pre-built graph + canned queries → verify correct subgraph extraction and output format. Both NL mode (mocked LLM) and offline keyword mode. Target: ~20 tests.
- **CLI commands** (integration): End-to-end tests running `jam intel scan` / `query` / `impact` against fixture repos. Target: ~15 tests.
- **Performance benchmarks**: Structural scan of 500-file repo completes in < 3 seconds. Graph load of 5,000-node JSON completes in < 1 second. Query against 5,000-node graph returns in < 500ms (excluding LLM time).

## Competitive Positioning

| vs | jam intel difference |
|----|---------------------|
| Sourcegraph / CodeSee | Those map structure. jam intel understands intent. |
| GitHub Copilot Workspace | Copilot helps write code. jam intel helps understand systems. |
| Architecture docs | Docs go stale day two. jam intel is always current. |
| Generic dep graphs | Static import trees. jam intel adds semantic meaning, risk, and NL queries. |
| Everyone | Nobody does COBOL + modern stack in one graph. Enterprise legacy-to-cloud niche. |
