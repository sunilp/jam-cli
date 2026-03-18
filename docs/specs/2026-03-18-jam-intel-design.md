# jam intel — Codebase Intelligence

**Date:** 2026-03-18
**Status:** Design approved, pending implementation plan

## Overview

`jam intel` is a codebase intelligence feature that analyzes entire repositories (or multiple repos) to build a semantic knowledge graph — understanding not just what code exists, but what it does, why it exists, and how changing one thing affects everything else. It provides interactive visual exploration through a VSCode sidebar panel and a full browser-based graph explorer with natural language querying.

### What makes it different

- **Understands intent, not just structure** — LLM-enriched nodes carry purpose, domain, pattern, and risk metadata. "This is the authentication middleware" vs "these files import each other."
- **Multi-repo, multi-language** — links services across repositories, including legacy systems (COBOL) alongside modern stacks.
- **Always current** — file watcher keeps the graph in sync. No stale architecture docs.
- **Architecture diagram first** — initial scan immediately produces a visual architecture diagram before any LLM enrichment. The diagram upgrades in place as semantic understanding deepens.
- **Queryable** — natural language queries answered against the graph with visual responses.

## Architecture

### System Pipeline

```
Source Repos → Static Analyzers → LLM Enrichment → Knowledge Graph → Consumers
```

**Static Analyzers** (offline, seconds): AST parsing, import graphs, call graphs, DB schema extraction, API endpoint detection, config/Docker/CI analysis. Builds the structural skeleton.

**LLM Enrichment** (background, progressive): Adds semantic metadata to every node — purpose, domain, pattern, risk, summary, and semantic edges that static analysis can't see. Prioritized by connectivity × change frequency.

**Knowledge Graph**: Hybrid storage — JSON on disk (`.jam/intel/graph.json` per repo), in-memory graph at runtime for fast querying. Portable, git-friendly, no database dependency.

**Consumers**: VSCode sidebar panel, browser explorer, CLI, Copilot Chat (`@jam /intel`).

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

No LLM needed. Builds the skeleton graph immediately and generates the first architecture diagram.

**Extracts:**
- File tree and language detection
- Import graph and exports / public API
- Class and function signatures
- Database schemas (SQL migrations, ORM models)
- API routes (Express, Flask, Spring, etc.)
- Package manifests (package.json, requirements.txt, pom.xml, etc.)
- Docker / docker-compose configuration
- CI/CD pipeline definitions
- Environment variable references and config files

**Immediate output:**
- Architecture diagram generated from structural data (service boundaries, major modules, connections)
- Graph is explorable immediately
- Diagram opens in browser automatically

### Phase 2: Progressive LLM Enrichment (background, minutes)

Runs in background while the user explores the structural graph. Nodes are enriched in priority order:

1. **Priority 1** — Entry points, high-connectivity hubs, most-changed files (via git history)
2. **Priority 2** — Service boundaries, API layers, database access patterns
3. **Priority 3** — Internal modules, utilities, tests, leaf nodes

As enrichment progresses:
- Architecture diagram upgrades in place with semantic labels, domain groupings, purpose annotations
- Flow diagrams are generated (data flow, request lifecycle, event flow)
- API dependency maps appear
- Cross-repo interaction diagrams surface
- Nodes in the explorer gain semantic badges in real-time

**Per node, the LLM generates:** purpose label, domain tag, pattern detection, risk score, plain-English summary, semantic edges (relationships static analysis missed).

### Phase 3: File Watcher — Continuous Sync (ongoing)

Watches for file changes and incrementally updates the graph:

- **File saved** → re-parse AST, update edges, queue for LLM re-enrichment
- **File created** → add node, run static analysis, queue for enrichment
- **File deleted** → remove node, clean up dangling edges
- **Branch switch** → diff the file tree, batch-update changed nodes
- **Dependency change** → re-scan package manifests, update external nodes

### Language Support — Pluggable Analyzers

Each language gets an analyzer plugin:

**v1 (Launch):** TypeScript/JavaScript, Python, Java, COBOL, SQL (migrations/schemas), Docker/docker-compose, OpenAPI/Swagger

**v2 (Expand):** Go, Rust, C#/.NET, Ruby, Terraform/Kubernetes, GraphQL

**v3 (Community):** Plugin API for custom analyzers (`jam plugin create --analyzer`)

### Multi-Repo — Workspace Manifest

Multiple repos are linked via a workspace manifest:

```json
// .jam/intel/workspace.json
{
  "repos": [
    { "name": "api-service", "path": "../api-service" },
    { "name": "web-app", "path": "../web-app" },
    { "name": "legacy-batch", "path": "../legacy-batch" }
  ],
  "crossRepoEdges": [
    { "from": "api-service:UserEndpoint", "to": "web-app:UserApi", "type": "consumes" },
    { "from": "api-service:events", "to": "web-app:webhookHandler", "type": "subscribes" },
    { "from": "shared-lib:types", "to": "api-service:models", "type": "imports" }
  ]
}
```

Cross-repo edges are discovered by LLM (matching API contracts, shared types, event names) and confirmed by static analysis where possible.

## Visualization & Query Layer

### Two-Tier Visualization

**VSCode Sidebar Panel (lightweight):**
- Architecture tree view (always visible)
- Enrichment progress indicator
- Quick query input
- Click node → jump to file in editor
- "Open in Browser" button for full explorer
- Auto-refreshes on file save

**Browser Explorer (full interactive):**
- Zoomable, pannable graph visualization
- Filter chips: All Repos, Services, Data Flow, API Layer, Database
- Natural language query bar
- Click node → detail panel (purpose, dependencies, risk, file links)
- Animated impact paths for query results
- Drill-down: click a service → see its internal modules → see individual files

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

### Query → Visual Response Flow

Example: "What breaks if I rename the users table?"

1. LLM parses query → identifies target node: `table:users`
2. Graph traversal → find all nodes connected via `reads`, `writes`, `references` edges (transitive)
3. LLM enriches results → explains the impact in context ("The COBOL batch job parses the record layout directly — a schema change requires updating the COPYBOOK")
4. Visualizer highlights the impact subgraph — affected nodes glow, edges animate to show propagation paths
5. Detail panel shows: affected files with risk scores, suggested migration steps, "Open in editor" links

## CLI Commands

```
jam intel scan                           # Scan current repo, generate architecture diagram
jam intel scan --workspace ../a ../b     # Multi-repo scan with workspace manifest
jam intel query "what handles auth?"     # Natural language query (text + Mermaid output)
jam intel impact src/models/user.ts      # Impact analysis for a specific file
jam intel explore                        # Open browser-based interactive explorer
jam intel diagram --format mermaid       # Export architecture diagram
jam intel status                         # Enrichment progress and graph stats
```

### Scan Output Behavior

```
$ jam intel scan
⚡ Structural scan... 247 files, 1,842 nodes, 3,291 edges (2.1s)
🏗️ Architecture diagram generated → opening in browser...
🧠 LLM enrichment started (diagram will update as understanding deepens)
💾 Saved to .jam/intel/graph.json
```

The architecture diagram is the hero artifact — generated immediately from structural data, opens in browser, and progressively upgrades as the LLM enriches nodes.

## VSCode Extension Integration

### Sidebar Panel
- Architecture tree view (always visible)
- Enrichment progress bar
- Quick query input
- Click node → jump to file in editor
- "Open in Browser" for full explorer
- Auto-refreshes on file save

### Context-Aware Actions
- Right-click file → "Show Impact Analysis"
- Right-click function → "What depends on this?"
- Right-click file → "Show in Architecture Graph"
- Hover over import → see purpose of that module
- Status bar shows current file's domain tag

### Auto-Scan Triggers
- On workspace open → load cached graph
- On file save → incremental re-scan
- On git branch switch → diff and update
- On new repo added to workspace → auto-scan
- Background enrichment via extension host

### Command Palette
- `Jam: Scan Workspace` — full re-scan
- `Jam: Query Intelligence` — NL query input box
- `Jam: Impact Analysis` — for current file
- `Jam: Open Explorer` — browser view
- `Jam: Explain Architecture` — system overview

## Copilot Chat Integration

`@jam /intel` queries the knowledge graph from within Copilot Chat:

```
@jam /intel What happens if I change the payment processing logic?
```

Responds with graph-aware context including cross-repo impact, risk assessment, and references to specific files — including legacy COBOL programs where applicable.

## Testing Strategy

- **Static analyzers**: Unit tests per language analyzer with fixture repos
- **Graph model**: Unit tests for node/edge operations, traversal, serialization
- **LLM enrichment**: Mock-based tests for prompt construction and response parsing
- **File watcher**: Integration tests with temp repos and simulated file changes
- **Query layer**: End-to-end tests with pre-built graphs and expected query results
- **Visualization**: Manual testing for VSCode panel and browser explorer
- **Multi-repo**: Integration tests with multi-repo workspace fixtures

## Competitive Positioning

| vs | jam intel difference |
|----|---------------------|
| Sourcegraph / CodeSee | Those map structure. jam intel understands intent. |
| GitHub Copilot Workspace | Copilot helps write code. jam intel helps understand systems. |
| Architecture docs | Docs go stale day two. jam intel is always current. |
| Generic dep graphs | Static import trees. jam intel adds semantic meaning, risk, and NL queries. |
| Everyone | Nobody does COBOL + modern stack in one graph. Enterprise legacy-to-cloud niche. |
