# jam deps -- Dependency Graph Analyzer

Analyze the import dependency graph of your project. Detects circular imports,
orphan files, and import hotspots using pure regex parsing -- no AST needed,
instant on large codebases. This is a zero-LLM command; it works without any
AI provider configured.

## Synopsis

```
jam deps [options]
```

## Options

| Flag | Description |
|------|-------------|
| `--circular` | Show only circular dependency cycles |
| `--orphans` | Show only orphan files (imported by nothing) |
| `--hotspots` | Show only import hotspots (most-imported files) |
| `--src <dir>` | Limit analysis to a source directory |
| `--json` | Output results as JSON |

When no filter flag is given, all three analyses run together with a summary.

## How It Works

- Scans all git-tracked source files (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`)
- Extracts imports using regex: ES `import/export ... from`, `require()`, dynamic `import()`
- Only follows relative imports (skips `node_modules` and built-in modules)
- Resolves extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`) and `index` files
- Handles the common `.js` to `.ts` ESM mapping
- Excludes test files (`.test.ts`, `.spec.ts`, `.test.tsx`, `.spec.tsx`) and declaration files (`.d.ts`)
- Excludes `node_modules/` and `dist/` directories
- Uses Tarjan's strongly connected components algorithm for cycle detection

## Examples

### 1. Full project overview

Run without flags to get cycles, orphans, hotspots, and a summary in one pass:

```
jam deps
```

Output:

```
Circular Dependencies (2)

  Cycle 1: src/config/loader.ts -> src/config/schema.ts -> src/config/loader.ts
  Cycle 2: src/tools/registry.ts -> src/tools/read_file.ts -> src/tools/registry.ts

Orphan Files (imported by nothing -- 3)

  * src/commands/legacy.ts
  * src/utils/deprecated.ts
  * src/helpers/old-format.ts

Import Hotspots (most imported)

  ████████████████████  12  src/utils/errors.ts
  ███████████████       9  src/config/loader.ts
  ██████████            6  src/utils/logger.ts
  ████████              5  src/providers/base.ts
  ██████                4  src/utils/workspace.ts

24 files, 47 import edges, 2 cycles
```

### 2. Find circular dependencies

```
jam deps --circular
```

Output:

```
Circular Dependencies (1)

  Cycle 1: src/tools/registry.ts -> src/tools/read_file.ts -> src/tools/registry.ts
```

If there are no cycles:

```
No circular dependencies found.
```

### 3. Find orphan files

Orphan files are source files that nothing imports. Entry points (files matching
`index.*`, `main.*`, `cli.*`, or `src/index*`) are excluded from orphan
detection since they are expected to have no importers.

```
jam deps --orphans
```

Output:

```
Orphan Files (imported by nothing -- 2)

  * src/commands/experimental.ts
  * src/utils/scratch.ts
```

### 4. Limit to a subdirectory

Analyze only files under `src/commands/`:

```
jam deps --src src/commands
```

This is useful for large monorepos or when you only care about one module.

### 5. Get import hotspots

Find the most-imported files in the project. These are high-coupling points
where changes could have wide impact:

```
jam deps --hotspots
```

Output:

```
Import Hotspots (most imported)

  ████████████████████  14  src/utils/errors.ts
  ██████████████████    13  src/config/loader.ts
  ████████████          9  src/providers/base.ts
  ██████████            7  src/utils/logger.ts
  ████████              6  src/utils/workspace.ts
```

### 6. JSON output for CI or scripting

Get machine-readable output with `--json`. Works with any filter flag or alone:

```
jam deps --json
```

Full summary output:

```json
{
  "summary": {
    "files": 24,
    "imports": 47,
    "cycles": 1
  },
  "cycles": [
    ["src/tools/registry.ts", "src/tools/read_file.ts"]
  ],
  "orphans": [
    "src/utils/scratch.ts"
  ],
  "hotspots": [
    { "file": "src/utils/errors.ts", "importers": 14 },
    { "file": "src/config/loader.ts", "importers": 13 }
  ]
}
```

Filter-specific JSON:

```
jam deps --circular --json
```

```json
{
  "cycles": [
    ["src/tools/registry.ts", "src/tools/read_file.ts"]
  ]
}
```

### 7. Use in CI to block circular imports

```bash
# Fail the build if any circular dependencies exist
if jam deps --circular --json | jq -e '.cycles | length > 0' > /dev/null 2>&1; then
  echo "ERROR: Circular dependencies detected"
  jam deps --circular
  exit 1
fi
```

## Notes

- Requires a git repository (uses `git ls-files` to discover source files)
- Only analyzes relative imports; external package imports are ignored
- The hotspots view shows the top 15 most-imported files
- The orphans view caps at 20 files with a "... and N more" indicator
- Self-loops (a file importing itself) are reported as single-node cycles
