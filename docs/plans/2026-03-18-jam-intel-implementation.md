# jam intel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a codebase intelligence feature (`jam intel`) that scans repos, builds a semantic knowledge graph, generates architecture diagrams, and supports natural language queries — all from the CLI.

**Architecture:** Pluggable language analyzers feed a knowledge graph (in-memory graph + JSON persistence). A scanner orchestrates analysis, a Mermaid generator produces diagrams, an LLM enrichment engine adds semantic metadata progressively, and a query engine handles NL queries via tool-use pattern. Six CLI subcommands expose everything.

**Tech Stack:** TypeScript (ESM), vitest, zod, commander, chalk. No new dependencies for core — graph is hand-rolled, Mermaid is text generation.

**Spec:** `docs/specs/2026-03-18-jam-intel-design.md`

---

## Important Implementation Notes

- **ESM imports:** All imports must use `.js` extension (e.g., `import { X } from './types.js'`)
- **Verify compilation:** Always use `npx tsc --noEmit` (no file args) — individual file args bypass tsconfig
- **Lazy imports:** All command action handlers must use `await import(...)` pattern for fast CLI startup
- **Git in tests:** Use `execSync('git init', { cwd: workspace })` not `mkdir('.git')` — `git ls-files` needs a real repo
- **chatWithTools fallback:** The `chatWithTools` method is optional on `ProviderAdapter`. Always check `provider.chatWithTools != null` and fall back to offline keyword mode if unavailable.

---

## File Structure

```
src/intel/
├── index.ts              # Barrel export for public API
├── types.ts              # Node, Edge, KnowledgeGraph, SemanticMetadata types
├── graph.ts              # IntelGraph class — in-memory graph with traversal, query, serialization
├── graph.test.ts         # Graph unit tests
├── scanner.ts            # Scanner — orchestrates analyzers, builds graph, detects frameworks
├── scanner.test.ts       # Scanner integration tests with fixture repos
├── storage.ts            # Load/save graph.json + enrichment.json, .lock
├── storage.test.ts       # Storage unit tests
├── mermaid.ts            # Mermaid diagram generators (architecture, flow, deps, impact, query result)
├── mermaid.test.ts       # Mermaid output tests
├── enrichment.ts         # LLM enrichment engine — priority queue, budget, progressive
├── enrichment.test.ts    # Enrichment tests (mocked LLM)
├── query.ts              # Query engine — NL via tool-use, offline keyword mode
├── query.test.ts         # Query tests
├── viewer.ts             # Static HTML generator for Mermaid viewer (auto-reload)
├── analyzers/
│   ├── base.ts           # AnalyzerPlugin interface, AnalyzerRegistry
│   ├── typescript.ts     # TS/JS analyzer (extends existing src/analyzers/)
│   ├── typescript.test.ts
│   ├── python.ts         # Python analyzer (regex-based)
│   ├── python.test.ts
│   ├── cobol.ts          # COBOL analyzer (regex-based)
│   ├── cobol.test.ts
│   ├── sql.ts            # SQL migration/schema analyzer
│   ├── sql.test.ts
│   ├── docker.ts         # Docker/docker-compose analyzer
│   ├── docker.test.ts
│   ├── openapi.ts        # OpenAPI/Swagger analyzer
│   ├── openapi.test.ts
│   └── registry.ts       # Default analyzer registry setup
├── frameworks/
│   ├── detector.ts       # Framework detection from file markers
│   ├── detector.test.ts
│   ├── profiles.ts       # Framework profile definitions (Express, dbt, Airflow, etc.)
│   └── profiles.test.ts
src/commands/
│   └── intel.ts          # CLI command: jam intel scan|query|impact|explore|diagram|status
src/config/
│   └── schema.ts         # (modify) Add IntelConfigSchema
```

---

### Task 1: Knowledge Graph Types

**Files:**
- Create: `src/intel/types.ts`

- [ ] **Step 1: Write the types file**

```typescript
// src/intel/types.ts

export type NodeType =
  | 'repo' | 'service' | 'module' | 'file'
  | 'class' | 'function' | 'endpoint'
  | 'table' | 'schema' | 'queue' | 'event'
  | 'config' | 'external';

export type EdgeType =
  | 'imports' | 'calls'
  | 'reads' | 'writes'
  | 'publishes' | 'subscribes'
  | 'exposes' | 'consumes'
  | 'contains' | 'configures'
  | 'deploys-with' | 'depends-on';

export type EnrichDepth = 'shallow' | 'deep' | 'none';

export interface IntelNode {
  id: string;
  type: NodeType;
  name: string;
  filePath?: string;
  line?: number;
  language?: string;
  framework?: string;
  metadata: Record<string, unknown>;
}

export interface IntelEdge {
  source: string;
  target: string;
  type: EdgeType;
  metadata?: Record<string, unknown>;
}

export interface SemanticMetadata {
  nodeId: string;
  purpose?: string;
  pattern?: string;
  domain?: string;
  risk?: 'low' | 'medium' | 'high';
  summary?: string;
  semanticEdges?: Array<{ target: string; type: EdgeType; reason: string }>;
  enrichedAt?: string;
  depth: EnrichDepth;
}

export interface SerializedGraph {
  version: 1;
  scannedAt: string;
  rootDir: string;
  nodeCount: number;
  edgeCount: number;
  nodes: IntelNode[];
  edges: IntelEdge[];
  frameworks: string[];
  languages: string[];
  mtimes: Record<string, number>;
}

export interface SerializedEnrichment {
  version: 1;
  enrichedAt: string;
  depth: EnrichDepth;
  tokensUsed: number;
  entries: SemanticMetadata[];
}

export interface IntelStats {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  languages: string[];
  frameworks: string[];
  enrichmentProgress: number;
  tokensUsed: number;
  lastScannedAt?: string;
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/intel/types.ts
git commit -m "feat(intel): add knowledge graph type definitions"
```

---

### Task 2: IntelGraph Class

**Files:**
- Create: `src/intel/graph.ts`
- Create: `src/intel/graph.test.ts`

- [ ] **Step 1: Write failing tests**

Test cases (see spec for full test code):
- `adds and retrieves nodes` — verify nodeCount and getNode
- `adds and retrieves edges` — verify edgeCount
- `returns null for missing node`
- `finds neighbors (outgoing)` — verify directional traversal
- `finds neighbors (incoming)` — verify reverse traversal
- `filters nodes by type`
- `traverses paths between nodes` — BFS shortest path
- `returns null for no path`
- `finds impact subgraph` — all nodes reachable via incoming edges (reverse BFS)
- `serializes and deserializes` — roundtrip preserves nodes/edges
- `keyword search matches node names`
- `computes stats`
- `removes a node and its edges`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/intel/graph.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement IntelGraph**

Key methods:
- `addNode(node)`, `getNode(id)`, `removeNode(id)`
- `addEdge(edge)`, `getEdgesFrom(nodeId)`, `getEdgesTo(nodeId)`
- `getNeighbors(nodeId, direction)` — outgoing/incoming/both
- `filterByType(type)` — returns matching nodes
- `findPath(fromId, toId)` — BFS shortest path
- `getImpactSubgraph(nodeId)` — reverse BFS (all nodes that depend on this)
- `search(keyword)` — case-insensitive match on name and filePath
- `serialize(rootDir)` / `static deserialize(data)` — JSON roundtrip
- `getStats()` — aggregate statistics
- `estimateTokens(depth)` — returns estimated token count based on node count × tokens-per-node for `--dry-run`

Internal: adjacency lists via `Map<string, Set<number>>` for outgoing/incoming edge indices.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/intel/graph.test.ts`
Expected: All 13 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/intel/graph.ts src/intel/graph.test.ts
git commit -m "feat(intel): add IntelGraph class with traversal, search, serialization"
```

---

### Task 3: Analyzer Plugin Interface + Registry

**Files:**
- Create: `src/intel/analyzers/base.ts`
- Create: `src/intel/analyzers/registry.ts`

- [ ] **Step 1: Write the analyzer interface**

```typescript
// src/intel/analyzers/base.ts
import type { IntelNode, IntelEdge } from '../types.js';

export interface FileAnalysis {
  nodes: IntelNode[];
  edges: IntelEdge[];
}

export interface ProjectAnalysisResult {
  nodes: IntelNode[];
  edges: IntelEdge[];
  frameworks: string[];
}

export interface AnalyzerPlugin {
  name: string;
  languages: string[];
  extensions: string[];
  /** Exact filenames to match (e.g., 'Dockerfile', 'docker-compose.yml') */
  filenames?: string[];
  /** Analyze a single file. rootDir provided for import resolution. */
  analyzeFile(content: string, relPath: string, rootDir: string): FileAnalysis;
  /** Optional: cross-file analysis after all files scanned */
  analyzeProject?(allNodes: IntelNode[], allEdges: IntelEdge[], rootDir: string): ProjectAnalysisResult;
}
```

- [ ] **Step 2: Write the registry with filename + extension matching**

```typescript
// src/intel/analyzers/registry.ts
import { basename } from 'node:path';
import type { AnalyzerPlugin } from './base.js';

export class AnalyzerRegistry {
  private plugins: AnalyzerPlugin[] = [];
  private extMap = new Map<string, AnalyzerPlugin>();
  private filenameMap = new Map<string, AnalyzerPlugin>();

  register(plugin: AnalyzerPlugin): void {
    this.plugins.push(plugin);
    for (const ext of plugin.extensions) {
      this.extMap.set(ext, plugin);
    }
    for (const name of plugin.filenames ?? []) {
      this.filenameMap.set(name, plugin);
    }
  }

  getForFile(filePath: string): AnalyzerPlugin | null {
    const name = basename(filePath);
    // Check exact filename first (Dockerfile, docker-compose.yml)
    if (this.filenameMap.has(name)) return this.filenameMap.get(name)!;
    // Then check extension
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx >= 0) {
      const ext = name.slice(dotIdx);
      if (this.extMap.has(ext)) return this.extMap.get(ext)!;
    }
    return null;
  }

  getAll(): AnalyzerPlugin[] { return [...this.plugins]; }
}
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/intel/analyzers/base.ts src/intel/analyzers/registry.ts
git commit -m "feat(intel): add AnalyzerPlugin interface and registry with filename matching"
```

---

### Task 4: Config Schema Addition

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/defaults.ts`

> Moved before Scanner task — Scanner and Enrichment need these config values.

- [ ] **Step 1: Add IntelConfigSchema to schema.ts**

```typescript
export const IntelConfigSchema = z.object({
  enrichDepth: z.enum(['shallow', 'deep', 'none']).default('deep'),
  maxTokenBudget: z.number().int().positive().default(500000),
  storageDir: z.string().default('.jam/intel'),
  autoScan: z.boolean().default(false),
  excludePatterns: z.array(z.string()).default([
    'node_modules', 'dist', '.git', 'vendor', '__pycache__', '.venv', 'target', 'build',
  ]),
  diagramFormat: z.literal('mermaid').default('mermaid'),
  openBrowserOnScan: z.boolean().default(true),
});
export type IntelConfig = z.infer<typeof IntelConfigSchema>;
```

Add `intel: IntelConfigSchema.default({})` to `JamConfigSchema`.

- [ ] **Step 2: Add defaults to `src/config/defaults.ts`**

Add `intel: {}` to `CONFIG_DEFAULTS` (Zod defaults handle the rest).

- [ ] **Step 3: Verify existing tests still pass**

Run: `npx vitest run`
Expected: All 388+ tests pass

- [ ] **Step 4: Commit**

```bash
git add src/config/schema.ts src/config/defaults.ts
git commit -m "feat(intel): add intel config schema with enrichment, storage, and diagram options"
```

---

### Task 5: TypeScript/JavaScript Analyzer

**Files:**
- Create: `src/intel/analyzers/typescript.ts`
- Create: `src/intel/analyzers/typescript.test.ts`

- [ ] **Step 1: Write failing tests**

Tests should cover:
- File node extraction with `language: 'typescript'` (or 'javascript' for .js)
- Exported function extraction → `function` nodes
- Exported class extraction → `class` nodes
- Import edge extraction using `extractImports()` from `src/analyzers/imports.ts`
- Import resolution via `rootDir` parameter (resolve `./services/user.js` → `src/services/user.ts`)
- Express route detection (`app.get('/path', handler)`) → `endpoint` nodes with `framework: 'express'`
- React component detection (JSX return in `.tsx`) → `framework: 'react'`
- `process.env.X` extraction → `config` nodes
- `contains` edges from file to its symbols

Note: `analyzeFile` receives `rootDir` so import paths can be resolved to actual files. Use `resolveImport()` from `src/analyzers/imports.ts` for resolution.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/intel/analyzers/typescript.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement TypeScriptAnalyzer**

Reuse:
- `extractImports(content)` from `src/analyzers/imports.ts`
- `resolveImport(importPath, fromFile, root)` from `src/analyzers/imports.ts`
- `extractSymbols(content, file, module)` from `src/analyzers/structure.ts`

Extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/intel/analyzers/typescript.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/intel/analyzers/typescript.ts src/intel/analyzers/typescript.test.ts
git commit -m "feat(intel): add TypeScript/JavaScript analyzer with Express and React detection"
```

---

### Task 6: Python Analyzer

**Files:**
- Create: `src/intel/analyzers/python.ts`
- Create: `src/intel/analyzers/python.test.ts`

- [ ] **Step 1: Write failing tests**

Tests should cover:
- File node with `language: 'python'`
- `import X` and `from X import Y` as import edges
- `class` and `def` extraction
- Flask routes: `@app.route('/path')` → endpoint nodes
- Django URLs: `path('url', view)` → endpoint nodes
- SQLAlchemy: `class X(Base):` with `Column()` → table nodes
- Airflow DAGs: `@dag` or `DAG(` → framework metadata
- dbt: detection deferred to framework detector (project-level)
- Spark: `SparkSession` import → framework metadata
- `os.environ` / `os.getenv` → config nodes

Extensions: `.py`

- [ ] **Step 2-4: Implement and verify**

Regex-based. Same TDD cycle as Task 5.

- [ ] **Step 5: Commit**

```bash
git add src/intel/analyzers/python.ts src/intel/analyzers/python.test.ts
git commit -m "feat(intel): add Python analyzer with Flask, Django, SQLAlchemy, Airflow, Spark detection"
```

---

### Task 7: COBOL Analyzer

**Files:**
- Create: `src/intel/analyzers/cobol.ts`
- Create: `src/intel/analyzers/cobol.test.ts`

- [ ] **Step 1: Write failing tests**

Tests should cover:
- PROGRAM-ID extraction
- COPY statement → import edges (COPYBOOK references)
- CALL statement → `calls` edges
- EXEC SQL → table references as `reads`/`writes` edges
- EXEC CICS → `framework: 'cics'`
- SECTION/PARAGRAPH extraction → function nodes
- FD (file descriptor) extraction

Extensions: `.cbl`, `.cob`, `.cpy`, `.CBL`, `.COB`, `.CPY`

- [ ] **Step 2-4: Implement and verify**

- [ ] **Step 5: Commit**

```bash
git add src/intel/analyzers/cobol.ts src/intel/analyzers/cobol.test.ts
git commit -m "feat(intel): add COBOL analyzer with COPYBOOK, EXEC SQL/CICS, CALL detection"
```

---

### Task 8: SQL Analyzer

**Files:**
- Create: `src/intel/analyzers/sql.ts`
- Create: `src/intel/analyzers/sql.test.ts`

- [ ] **Step 1: Write failing tests**

Tests should cover:
- `CREATE TABLE X` → `table` node with column metadata
- `ALTER TABLE` / `FOREIGN KEY REFERENCES Y` → `depends-on` edge
- `INSERT INTO X` / `SELECT FROM X` → `writes`/`reads` edges
- dbt `{{ ref('model') }}` → `depends-on` edge
- dbt `{{ source('src', 'table') }}` → `reads` edge
- Migration file ordering (from filename pattern)

Extension: `.sql`

- [ ] **Step 2-4: Implement and verify**

- [ ] **Step 5: Commit**

```bash
git add src/intel/analyzers/sql.ts src/intel/analyzers/sql.test.ts
git commit -m "feat(intel): add SQL analyzer with dbt ref/source, CREATE TABLE, FK detection"
```

---

### Task 9: Docker Analyzer

**Files:**
- Create: `src/intel/analyzers/docker.ts`
- Create: `src/intel/analyzers/docker.test.ts`

- [ ] **Step 1: Write failing tests**

Tests should cover:
- docker-compose.yml: service extraction → `service` nodes
- `depends_on` → `deploys-with` edges
- Port mappings as metadata
- Volume mounts as metadata
- Dockerfile: `FROM` → `external` node for base image
- `EXPOSE` port as metadata

Filenames: `Dockerfile`, `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, `compose.yaml`
Extensions: (none — matched by filename)

- [ ] **Step 2-4: Implement and verify**

Simple line-by-line YAML parsing for docker-compose (detect `services:` block, parse indentation). No full YAML parser needed.

- [ ] **Step 5: Commit**

```bash
git add src/intel/analyzers/docker.ts src/intel/analyzers/docker.test.ts
git commit -m "feat(intel): add Docker/docker-compose analyzer with service topology"
```

---

### Task 10: OpenAPI Analyzer

**Files:**
- Create: `src/intel/analyzers/openapi.ts`
- Create: `src/intel/analyzers/openapi.test.ts`

- [ ] **Step 1: Write failing tests**

Tests should cover:
- `paths:` block → `endpoint` nodes with method + path
- `components/schemas` → `schema` nodes
- `$ref` references → edges between schemas
- Detection: only analyze `.yaml`/`.yml`/`.json` files that contain `openapi:` or `swagger:` key

Extensions: `.yaml`, `.yml` (filtered by content detection in `analyzeFile`)

- [ ] **Step 2-4: Implement and verify**

JSON.parse for `.json`. Simple line-by-line YAML parsing for paths and schemas (no full YAML parser).

- [ ] **Step 5: Commit**

```bash
git add src/intel/analyzers/openapi.ts src/intel/analyzers/openapi.test.ts
git commit -m "feat(intel): add OpenAPI/Swagger analyzer with endpoint and schema extraction"
```

---

### Task 11: Framework Detector

**Files:**
- Create: `src/intel/frameworks/detector.ts`
- Create: `src/intel/frameworks/profiles.ts`
- Create: `src/intel/frameworks/detector.test.ts`
- Create: `src/intel/frameworks/profiles.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// Tests use temp directories with specific files to trigger detection
// Each test creates the marker file and verifies the framework is detected

describe('detectFrameworks', () => {
  it('detects Express from package.json dependencies');
  it('detects React from package.json dependencies');
  it('detects dbt from dbt_project.yml');
  it('detects Django from manage.py');
  it('detects Flask from app.py with Flask import');
  it('detects Airflow from dags/ directory with DAG imports');
  it('detects Docker Compose from docker-compose.yml');
  it('detects Prisma from schema.prisma');
  it('detects Kafka from package.json or Python kafka imports');
  it('detects Spark from PySpark imports');
  it('detects SQLAlchemy from Python files with declarative_base');
  it('returns empty for vanilla project');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/intel/frameworks/detector.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement profiles and detector**

`profiles.ts` — declarative detection rules:
```typescript
export interface FrameworkProfile {
  name: string;
  markers: Array<{
    type: 'file-exists' | 'package-dep' | 'dir-exists' | 'file-contains';
    pattern: string;
    file?: string;
  }>;
}

export const FRAMEWORK_PROFILES: FrameworkProfile[] = [
  { name: 'express', markers: [{ type: 'package-dep', pattern: 'express' }] },
  { name: 'react', markers: [{ type: 'package-dep', pattern: 'react' }] },
  { name: 'dbt', markers: [{ type: 'file-exists', pattern: 'dbt_project.yml' }] },
  { name: 'django', markers: [{ type: 'file-exists', pattern: 'manage.py' }] },
  { name: 'airflow', markers: [{ type: 'dir-exists', pattern: 'dags' }] },
  { name: 'docker-compose', markers: [{ type: 'file-exists', pattern: 'docker-compose.yml' }] },
  { name: 'prisma', markers: [{ type: 'file-exists', pattern: 'schema.prisma' }] },
  // ... etc.
];
```

`detector.ts` — checks markers against filesystem.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/intel/frameworks/detector.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/intel/frameworks/
git commit -m "feat(intel): add framework detector with profiles for Express, dbt, React, Django, Airflow, Prisma, Kafka, Spark"
```

---

### Task 12: Analyzer Registry Setup

**Files:**
- Create: `src/intel/analyzers/registry.ts` (already has class — now add default setup)

- [ ] **Step 1: Add createDefaultRegistry function**

```typescript
// Add to src/intel/analyzers/registry.ts
import { TypeScriptAnalyzer } from './typescript.js';
import { PythonAnalyzer } from './python.js';
import { CobolAnalyzer } from './cobol.js';
import { SqlAnalyzer } from './sql.js';
import { DockerAnalyzer } from './docker.js';
import { OpenApiAnalyzer } from './openapi.js';

export function createDefaultRegistry(): AnalyzerRegistry {
  const registry = new AnalyzerRegistry();
  registry.register(new TypeScriptAnalyzer());
  registry.register(new PythonAnalyzer());
  registry.register(new CobolAnalyzer());
  registry.register(new SqlAnalyzer());
  registry.register(new DockerAnalyzer());
  registry.register(new OpenApiAnalyzer());
  return registry;
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/intel/analyzers/registry.ts
git commit -m "feat(intel): add default analyzer registry with all v1 analyzers"
```

---

### Task 13: Scanner (Orchestrator)

**Files:**
- Create: `src/intel/scanner.ts`
- Create: `src/intel/scanner.test.ts`

- [ ] **Step 1: Write failing tests using a real git fixture workspace**

```typescript
import { execSync } from 'node:child_process';

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'jam-intel-scan-'));
  execSync('git init', { cwd: workspace }); // REAL git repo required
  // ... write fixture files ...
  execSync('git add -A && git commit -m "init"', { cwd: workspace });
});
```

Tests:
- `scans a workspace and returns a graph` — nodeCount > 0, edgeCount > 0
- `detects frameworks` — graph.frameworks includes 'express'
- `creates file nodes for all source files` — at least 3 files
- `creates endpoint nodes for Express routes` — at least 1 endpoint
- `records mtimes for incremental scanning`
- `incremental scan only re-analyzes changed files` — modify one file, re-scan, verify only that file's mtime updated

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/intel/scanner.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement Scanner**

```typescript
export class Scanner {
  private registry: AnalyzerRegistry;

  constructor(registry?: AnalyzerRegistry) {
    this.registry = registry ?? createDefaultRegistry();
  }

  /** Collect all source files — extends getSourceFiles pattern for all languages */
  async collectFiles(rootDir: string, excludePatterns: string[]): Promise<string[]> {
    // Use git ls-files if in a git repo, else recursive readdir
    // Filter by all registered analyzer extensions + filenames
    // Exclude patterns from config (node_modules, dist, etc.)
  }

  /** Full or incremental scan */
  async scan(rootDir: string, options?: {
    previousGraph?: IntelGraph;
    excludePatterns?: string[];
  }): Promise<IntelGraph> {
    const graph = new IntelGraph();
    const files = await this.collectFiles(rootDir, options?.excludePatterns ?? [...]);
    const frameworks = await detectFrameworks(rootDir);

    for (const relPath of files) {
      // Incremental: skip if mtime unchanged
      const mtime = (await stat(join(rootDir, relPath))).mtimeMs;
      if (options?.previousGraph?.mtimes[relPath] === mtime) {
        // Copy nodes/edges from previous graph for this file
        continue;
      }

      const analyzer = this.registry.getForFile(relPath);
      if (!analyzer) continue;
      const content = await readFile(join(rootDir, relPath), 'utf-8');
      const result = analyzer.analyzeFile(content, relPath, rootDir);
      for (const node of result.nodes) graph.addNode(node);
      for (const edge of result.edges) graph.addEdge(edge);
      graph.mtimes[relPath] = mtime;
    }

    // Cross-file analysis
    for (const plugin of this.registry.getAll()) {
      if (plugin.analyzeProject) {
        const result = plugin.analyzeProject(graph.allNodes(), graph.allEdges(), rootDir);
        for (const node of result.nodes) graph.addNode(node);
        for (const edge of result.edges) graph.addEdge(edge);
      }
    }

    graph.frameworks = frameworks;
    graph.languages = [...new Set(graph.allNodes().filter(n => n.language).map(n => n.language!))];
    return graph;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/intel/scanner.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/intel/scanner.ts src/intel/scanner.test.ts
git commit -m "feat(intel): add Scanner orchestrator with incremental scan support"
```

---

### Task 14: Storage Layer

**Files:**
- Create: `src/intel/storage.ts`
- Create: `src/intel/storage.test.ts`

- [ ] **Step 1: Write failing tests**

Tests:
- `saveGraph writes graph.json` — file exists after save
- `loadGraph reads and deserializes` — roundtrip preserves data
- `loadGraph returns null if no graph exists`
- `saveEnrichment writes enrichment.json`
- `loadEnrichment reads entries`
- `saveMermaid writes .mmd file and returns path`
- `checkGitignore returns false when .jam/intel not ignored`
- `lock file prevents concurrent writes` — second save throws while locked
- `lock file cleaned up after save`

- [ ] **Step 2-3: Implement and verify**

```typescript
export async function saveGraph(graph: IntelGraph, rootDir: string): Promise<void>
export async function loadGraph(rootDir: string): Promise<IntelGraph | null>
export async function saveEnrichment(entries: SemanticMetadata[], meta: {...}, rootDir: string): Promise<void>
export async function loadEnrichment(rootDir: string): Promise<SerializedEnrichment | null>
export async function saveMermaid(mermaid: string, rootDir: string, filename?: string): Promise<string>
export function checkGitignore(rootDir: string): boolean
```

Locking: Use `writeFile` with `O_EXCL` flag (fails if file exists) for `.lock`. Wrap operations in try/finally to clean up lock.

Storage dir: `path.join(rootDir, '.jam', 'intel')`. Created automatically on first save.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/intel/storage.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/intel/storage.ts src/intel/storage.test.ts
git commit -m "feat(intel): add graph storage layer with JSON persistence and file locking"
```

---

### Task 15: Mermaid Diagram Generation

**Files:**
- Create: `src/intel/mermaid.ts`
- Create: `src/intel/mermaid.test.ts`

- [ ] **Step 1: Write failing tests**

Tests:
- `generates architecture diagram with graph TD` — contains subgraphs per module
- `generates dependency diagram with graph LR`
- `generates impact diagram for a node` — contains style highlighting
- `generates flow diagram` — shows reads/writes/publishes/subscribes
- `includes endpoints with hexagon shape`
- `includes database nodes with cylinder shape`
- `generates framework diagram for dbt` — shows ref() lineage
- `formatQueryResultAsMermaid highlights matching nodes` — query results become a subgraph with styling

- [ ] **Step 2-3: Implement**

Functions:
```typescript
export function generateArchitectureDiagram(graph: IntelGraph, options?): string
export function generateDepsDiagram(graph: IntelGraph, focus?): string
export function generateFlowDiagram(graph: IntelGraph): string
export function generateImpactDiagram(graph: IntelGraph, targetNodeId: string): string
export function generateFrameworkDiagram(graph: IntelGraph, framework?: string): string
export function formatQueryResultAsMermaid(nodes: IntelNode[], edges: IntelEdge[]): string
```

Mermaid shapes: `[( )]` for cylinders (tables), `{{ }}` for hexagons (endpoints), `[ ]` for boxes (modules), `([ ])` for rounded (services).

Reference: `src/commands/diagram.ts:generateArchitectureDiagram()` for existing patterns.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/intel/mermaid.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/intel/mermaid.ts src/intel/mermaid.test.ts
git commit -m "feat(intel): add Mermaid generators for architecture, deps, flow, impact, framework, query results"
```

---

### Task 16: Mermaid Viewer (Static HTML)

**Files:**
- Create: `src/intel/viewer.ts`

- [ ] **Step 1: Implement**

```typescript
export function generateViewerHtml(mermaidContent: string, mmdFilePath: string): string
export async function openInBrowser(htmlPath: string): Promise<void>
```

The HTML:
- Embeds Mermaid.js from CDN (`<script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js">`)
- Renders the diagram in a `<div class="mermaid">`
- Polls `.mmd` file via fetch every 2 seconds for auto-reload
- Dark theme

`openInBrowser` uses `child_process.exec('open')` on macOS, `xdg-open` on Linux, `start` on Windows.

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/intel/viewer.ts
git commit -m "feat(intel): add Mermaid viewer with auto-reload HTML page"
```

---

### Task 17: LLM Enrichment Engine

**Files:**
- Create: `src/intel/enrichment.ts`
- Create: `src/intel/enrichment.test.ts`

- [ ] **Step 1: Write failing tests (mocked LLM)**

Tests:
- `prioritize returns high-connectivity nodes first`
- `prioritize uses git churn data when available`
- `enrichAll stops when budget exceeded`
- `shallow enrichment produces only purpose and summary`
- `deep enrichment produces all metadata fields`
- `buildPrompt includes node context and neighbors` — use `vi.fn()` to capture prompt
- `parseResponse extracts structured metadata from JSON response`
- `getProgress returns 0-1 float`
- `skips node on LLM error and continues`
- `estimateTokens returns correct estimate for dry-run`

Mock the provider:
```typescript
const mockProvider = {
  info: { name: 'mock', supportsStreaming: true },
  async *streamCompletion(req) {
    yield { delta: JSON.stringify({ purpose: 'test', summary: 'test' }), done: true };
  },
} as unknown as ProviderAdapter;
```

- [ ] **Step 2-3: Implement**

```typescript
export class EnrichmentEngine {
  constructor(private provider: ProviderAdapter) {}
  prioritize(graph: IntelGraph, churnData?: Map<string, number>): string[]
  async enrichNode(node: IntelNode, graph: IntelGraph, depth: EnrichDepth): Promise<SemanticMetadata>
  async enrichAll(graph: IntelGraph, options: EnrichmentOptions): Promise<SemanticMetadata[]>
  buildPrompt(node: IntelNode, neighbors: IntelNode[], depth: EnrichDepth): { system: string; user: string }
  parseResponse(response: string, nodeId: string, depth: EnrichDepth): SemanticMetadata
  estimateTokens(graph: IntelGraph, depth: EnrichDepth): number
}
```

Priority formula: `score = inDegree(node) + outDegree(node) + (churnCount ?? 0)`. Sort descending.

Token estimation: `nodeCount * tokensPerNode` where shallow = 200, deep = 600.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/intel/enrichment.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/intel/enrichment.ts src/intel/enrichment.test.ts
git commit -m "feat(intel): add LLM enrichment engine with priority queue and budget control"
```

---

### Task 18: Query Engine

**Files:**
- Create: `src/intel/query.ts`
- Create: `src/intel/query.test.ts`

- [ ] **Step 1: Write failing tests**

Tests:
- `offline keyword search matches node names`
- `offline search with type filter returns only matching type`
- `offline search returns empty for no matches`
- `graph tools findNode returns correct nodes`
- `graph tools getNeighbors returns connected nodes`
- `graph tools filterByType returns typed nodes`
- `formatQueryResult produces readable text output`
- `query with --mermaid produces Mermaid output` — calls `formatQueryResultAsMermaid`
- `NL query falls back to offline when chatWithTools unavailable`
- `NL query with mocked chatWithTools executes graph operations`

- [ ] **Step 2-3: Implement**

```typescript
export interface QueryResult {
  nodes: IntelNode[];
  edges: IntelEdge[];
  explanation?: string;
  mermaid?: string;
}

export const GRAPH_TOOLS: ToolDefinition[] = [
  { name: 'findNode', description: 'Find nodes by keyword', parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] } },
  { name: 'getNeighbors', description: 'Get connected nodes', parameters: { type: 'object', properties: { nodeId: { type: 'string' }, direction: { type: 'string', enum: ['outgoing', 'incoming', 'both'] } }, required: ['nodeId'] } },
  // ... traversePath, filterByType, filterByDomain
];

export async function query(
  queryText: string,
  graph: IntelGraph,
  enrichment: SemanticMetadata[],
  provider: ProviderAdapter | null,
  options: QueryOptions,
): Promise<QueryResult>
```

Key: check `provider?.chatWithTools != null` before attempting NL mode. Fall back to offline if not available.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/intel/query.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/intel/query.ts src/intel/query.test.ts
git commit -m "feat(intel): add query engine with NL tool-use and offline keyword fallback"
```

---

### Task 19: Barrel Export

**Files:**
- Create: `src/intel/index.ts`

- [ ] **Step 1: Create barrel export**

```typescript
// src/intel/index.ts
export { IntelGraph } from './graph.js';
export { Scanner } from './scanner.js';
export { EnrichmentEngine } from './enrichment.js';
export { query } from './query.js';
export { saveGraph, loadGraph, saveEnrichment, loadEnrichment, saveMermaid, checkGitignore } from './storage.js';
export {
  generateArchitectureDiagram, generateDepsDiagram, generateFlowDiagram,
  generateImpactDiagram, generateFrameworkDiagram, formatQueryResultAsMermaid,
} from './mermaid.js';
export { generateViewerHtml, openInBrowser } from './viewer.js';
export type * from './types.js';
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/intel/index.ts
git commit -m "feat(intel): add barrel export for intel module"
```

---

### Task 20: CLI Command — `jam intel scan` + `jam intel status`

**Files:**
- Create: `src/commands/intel.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement scan and status subcommands**

```typescript
// src/commands/intel.ts
import type { CliOverrides } from '../config/schema.js';

export interface IntelScanOptions extends CliOverrides {
  noEnrich?: boolean;
  enrich?: string;
  dryRun?: boolean;
}

export async function runIntelScan(options: IntelScanOptions): Promise<void> {
  // Lazy imports inside the function
  const { Scanner } = await import('../intel/scanner.js');
  const { saveGraph, saveMermaid, loadGraph, checkGitignore } = await import('../intel/storage.js');
  const { generateArchitectureDiagram } = await import('../intel/mermaid.js');
  const { generateViewerHtml, openInBrowser } = await import('../intel/viewer.js');
  // ...
}

export async function runIntelStatus(): Promise<void> {
  const { loadGraph, loadEnrichment } = await import('../intel/storage.js');
  // ...
}
```

- [ ] **Step 2: Register in index.ts using lazy import pattern**

```typescript
// In src/index.ts — matches existing pattern
const intel = program.command('intel').description('Codebase intelligence — analyze, query, visualize');

intel.command('scan')
  .description('Scan codebase and build knowledge graph')
  .option('--no-enrich', 'Skip LLM enrichment')
  .option('--enrich <depth>', 'Enrichment depth: shallow or deep', 'deep')
  .option('--dry-run', 'Show scan estimate without running')
  .action(async (cmdOpts) => {
    const g = globalOpts();
    const { runIntelScan } = await import('./commands/intel.js');
    await runIntelScan({ profile: g.profile, provider: g.provider, ...cmdOpts });
  });

intel.command('status')
  .description('Show knowledge graph stats and enrichment progress')
  .action(async () => {
    const { runIntelStatus } = await import('./commands/intel.js');
    await runIntelStatus();
  });
```

- [ ] **Step 3: Test scan end-to-end**

Run: `npx tsx src/index.ts intel scan --no-enrich`
Expected: Scans jam-cli repo, shows node/edge counts, generates architecture diagram

- [ ] **Step 4: Test status**

Run: `npx tsx src/index.ts intel status`
Expected: Shows graph stats

- [ ] **Step 5: Commit**

```bash
git add src/commands/intel.ts src/index.ts
git commit -m "feat(intel): add jam intel scan and status CLI commands"
```

---

### Task 21: CLI Commands — `jam intel query`, `impact`, `diagram`, `explore`

**Files:**
- Modify: `src/commands/intel.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Add remaining command handlers to intel.ts**

```typescript
export async function runIntelQuery(text: string, options: IntelQueryOptions): Promise<void> { ... }
export async function runIntelImpact(file: string, options: IntelImpactOptions): Promise<void> { ... }
export async function runIntelDiagram(options: IntelDiagramOptions): Promise<void> { ... }
export async function runIntelExplore(): Promise<void> { ... }
```

- [ ] **Step 2: Register remaining subcommands in index.ts with lazy imports**

```typescript
intel.command('query <text>')
  .description('Query the knowledge graph')
  .option('--no-ai', 'Use keyword search only (offline)')
  .option('--mermaid', 'Output result as Mermaid diagram')
  .action(async (text, cmdOpts) => {
    const g = globalOpts();
    const { runIntelQuery } = await import('./commands/intel.js');
    await runIntelQuery(text, { profile: g.profile, provider: g.provider, ...cmdOpts });
  });

intel.command('impact <file>')
  .description('Show impact analysis for a file')
  .option('--mermaid', 'Output as Mermaid diagram')
  .action(async (file, cmdOpts) => {
    const { runIntelImpact } = await import('./commands/intel.js');
    await runIntelImpact(file, cmdOpts);
  });

intel.command('diagram')
  .description('Generate architecture diagram')
  .option('--type <type>', 'architecture, flow, deps, impact, framework', 'architecture')
  .option('-o, --output <file>', 'Output file path')
  .action(async (cmdOpts) => {
    const { runIntelDiagram } = await import('./commands/intel.js');
    await runIntelDiagram(cmdOpts);
  });

intel.command('explore')
  .description('Open knowledge graph in browser')
  .action(async () => {
    const { runIntelExplore } = await import('./commands/intel.js');
    await runIntelExplore();
  });
```

- [ ] **Step 3: Test query**

Run: `npx tsx src/index.ts intel query "providers" --no-ai`
Expected: Shows nodes matching "providers"

- [ ] **Step 4: Test impact**

Run: `npx tsx src/index.ts intel impact src/providers/base.ts`
Expected: Shows files that depend on base.ts

- [ ] **Step 5: Test diagram**

Run: `npx tsx src/index.ts intel diagram --type architecture`
Expected: Outputs Mermaid diagram to stdout

- [ ] **Step 6: Test explore**

Run: `npx tsx src/index.ts intel explore`
Expected: Opens browser with Mermaid diagram viewer

- [ ] **Step 7: Commit**

```bash
git add src/commands/intel.ts src/index.ts
git commit -m "feat(intel): add jam intel query, impact, diagram, explore CLI commands"
```

---

### Task 22: Integration Tests

**Files:**
- Create: `src/intel/intel.integration.test.ts`

- [ ] **Step 1: Write integration tests**

Fixture: real git repo with Express app + SQL migration + Dockerfile.

Tests:
- `scan → graph has correct node types` — file, function, class, endpoint, table, service, config
- `scan → graph has correct edge types` — imports, contains, reads, exposes
- `scan → detects Express framework`
- `scan → generates valid Mermaid architecture diagram`
- `scan → save → load roundtrip preserves graph`
- `incremental scan only re-analyzes changed files`
- `impact analysis traces through dependency chain`
- `keyword query finds matching nodes`
- `diagram --type deps shows module dependencies`
- `enrichment save → load roundtrip` (mock enrichment data)

- [ ] **Step 2: Run integration tests**

Run: `npx vitest run src/intel/intel.integration.test.ts`
Expected: All PASS

- [ ] **Step 3: Commit**

```bash
git add src/intel/intel.integration.test.ts
git commit -m "test(intel): add integration tests for full scan→query→diagram pipeline"
```

---

### Task 23: Build Verification & Smoke Test

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: All tests pass (existing 388 + new intel tests)

- [ ] **Step 3: Verify help output**

Run: `node dist/index.js intel --help`
Expected: Shows all 6 subcommands

- [ ] **Step 4: Manual smoke test**

```bash
node dist/index.js intel scan --no-enrich
node dist/index.js intel status
node dist/index.js intel query "provider" --no-ai
node dist/index.js intel impact src/providers/base.ts
node dist/index.js intel diagram
node dist/index.js intel explore
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat(intel): jam intel v1 complete — codebase intelligence with scan, query, impact, diagrams"
```
