# jam pack -- Package.json Analyzer

Analyze your project's package.json: dependency summary, on-disk size
breakdown, unused dependency detection, and script listing. This is a zero-LLM
command; it works without any AI provider configured.

## Synopsis

```
jam pack [options]
```

## Options

| Flag | Description |
|------|-------------|
| `--unused` | Show potentially unused dependencies |
| `--size` | Show dependency size breakdown (top 25) |
| `--scripts` | List all npm scripts with their commands |
| `--json` | Output as JSON |

When no flag is given, all analyses run together (summary, top 10 sizes,
unused, and scripts).

## How It Works

- Reads `package.json` from the workspace root (detected via git)
- For size analysis, measures on-disk size of each package in `node_modules/`
  by recursively summing file sizes
- For unused detection, scans all git-tracked source files for `import` and
  `require()` statements referencing non-relative packages, then compares
  against the dependencies listed in `package.json`
- Handles scoped packages (`@scope/name`)
- Common dev tools (typescript, eslint, prettier, vitest, jest, mocha, tsx,
  ts-node, nodemon, `@types/*`, lint-staged, husky, turbo, webpack, vite,
  rollup, esbuild) are excluded from unused detection since they are used via
  config files and scripts, not source imports

## Examples

### 1. Full project overview

```
jam pack
```

Output:

```
Package Summary
--------------------------------------------------
  Name:        jam-cli
  Version:     0.4.0
  Description: AI-powered CLI assistant
  Dependencies: 8 prod, 12 dev
  node_modules: 142.3MB
  Installed:   187 packages

Scripts
  build            tsc
  dev              tsx watch src/index.ts
  lint             eslint src
  test             vitest run
  typecheck        tsc --noEmit

Largest Dependencies
  ████████████████████    18.2MB  ink@4.4.1
  ████████████████        14.7MB  @anthropic-ai/sdk@0.24.0
  ██████████              9.1MB  typescript@5.4.5 dev
  ████████                7.3MB  react@18.2.0
  ██████                  5.5MB  chalk@5.3.0
  ████                    3.8MB  commander@12.1.0
  ████                    3.2MB  js-yaml@4.1.0
  ███                     2.9MB  marked@12.0.0
  ███                     2.4MB  cosmiconfig@9.0.0
  ██                      1.8MB  zod@3.23.0

Potentially Unused
  Production:
    ? some-unused-pkg
  Dev:
    ? forgotten-dev-tool
  (These may be used in config files or scripts)
```

### 2. Dependency size breakdown

Show the top 25 dependencies by on-disk size:

```
jam pack --size
```

Output:

```
Largest Dependencies
  ████████████████████    18.2MB  ink@4.4.1
  ████████████████        14.7MB  @anthropic-ai/sdk@0.24.0
  ██████████              9.1MB  typescript@5.4.5 dev
  ...
```

The bar chart is sorted by size. Dev dependencies are tagged with "dev".

### 3. Find unused dependencies

```
jam pack --unused
```

Output:

```
Potentially Unused
  Production:
    ? leftpad
    ? unused-middleware
  Dev:
    ? old-test-helper
  (These may be used in config files or scripts)
```

If everything looks good:

```
All dependencies appear to be used.
```

Only production dependencies are checked by default. Dev dependencies are also
checked but common tooling packages are excluded (see the list above).

### 4. List npm scripts

```
jam pack --scripts
```

Output:

```
Scripts

  build
    tsc

  dev
    tsx watch src/index.ts

  lint
    eslint src

  test
    vitest run

  typecheck
    tsc --noEmit
```

### 5. JSON output for size analysis

```
jam pack --size --json
```

Output:

```json
[
  { "name": "ink", "version": "4.4.1", "size": 19084288, "type": "prod" },
  { "name": "@anthropic-ai/sdk", "version": "0.24.0", "size": 15413248, "type": "prod" },
  { "name": "typescript", "version": "5.4.5", "size": 9543680, "type": "dev" }
]
```

### 6. JSON output for unused detection

```
jam pack --unused --json
```

Output:

```json
{
  "unused": ["leftpad", "unused-middleware"],
  "unusedDev": ["old-test-helper"]
}
```

### 7. JSON output for scripts

```
jam pack --scripts --json
```

Output:

```json
{
  "build": "tsc",
  "dev": "tsx watch src/index.ts",
  "lint": "eslint src",
  "test": "vitest run",
  "typecheck": "tsc --noEmit"
}
```

### 8. Full summary as JSON

```
jam pack --json
```

Output:

```json
{
  "name": "jam-cli",
  "version": "0.4.0",
  "dependencies": {
    "prod": 8,
    "dev": 12,
    "optional": 0,
    "peer": 0,
    "total": 20
  },
  "scripts": ["build", "dev", "lint", "test", "typecheck"]
}
```

### 9. Use in CI to check for unused dependencies

```bash
unused=$(jam pack --unused --json | jq '.unused | length')
if [ "$unused" -gt 0 ]; then
  echo "WARNING: $unused potentially unused production dependencies"
  jam pack --unused
fi
```

## Notes

- Requires a `package.json` in the workspace root.
- Size analysis requires `node_modules/` to be installed. If `node_modules/` is
  missing, the size section prints a message suggesting `npm install`.
- Unused detection scans `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` files
  using `git ls-files`, so untracked files are also included.
- The summary view (no flags) shows the top 10 largest dependencies. The
  `--size` flag expands this to the top 25.
- Dependency counts include prod, dev, optional, and peer categories.
