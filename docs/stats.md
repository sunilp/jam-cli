# jam stats

Instant codebase health dashboard. Shows lines of code by language, largest files, git churn analysis, and complexity hotspots -- all without an AI provider.

## Synopsis

```
jam stats [options]
```

## Options

| Flag | Description |
|------|-------------|
| `--sort <field>` | Sort the language table by: `code`, `lines`, `files`, `blank`, or `comment` (default: `code`) |
| `--json` | Output the full report as JSON |

## How It Works

1. Uses `git ls-files --cached --others --exclude-standard` to discover all tracked and unignored files.
2. Skips directories: `node_modules/`, `dist/`, `.git/`, `vendor/`, `build/`, `.next/`, `coverage/`.
3. Skips files larger than 1 MB.
4. Counts total lines, blank lines, comment lines, and code lines for each file. Comment detection covers `//`, `#`, `--` single-line comments and `/* ... */` block comments.
5. Aggregates counts by language using file extension mapping.
6. Runs `git log --since="90 days ago" --name-only` to compute file churn (how many commits touched each file in the last 90 days).
7. Scans code files for branch density (occurrences of `if`, `else`, `switch`, `case`, `for`, `while`, `catch`, `&&`, `||`, `?` per line) to identify complexity hotspots. Only files with more than 20 lines and more than 5 branch points are included.

## Supported Languages

Over 25 languages are recognized by file extension:

TypeScript, JavaScript, Python, Ruby, Go, Rust, Java, Kotlin, Swift, C, C++, C/C++ Header, C#, PHP, Vue, Svelte, Astro, HTML, CSS, SCSS, Less, JSON, YAML, TOML, XML, Markdown, SQL, Shell, Dockerfile, Terraform, HCL, Protobuf, GraphQL.

## Examples

### Run the full dashboard

```
jam stats
```

Sample output:

```
Codebase Stats
-----------------------------------------------------------------
  142 files   18,450 lines of code   24,300 total lines

Languages
  TypeScript           ████████████████████████  12,400 (67.2%)  85 files
  JavaScript           ██████░░░░░░░░░░░░░░░░░░   3,200 (17.3%)  22 files
  JSON                 ██░░░░░░░░░░░░░░░░░░░░░░   1,500 (8.1%)   18 files
  YAML                 █░░░░░░░░░░░░░░░░░░░░░░░     800 (4.3%)    9 files
  Markdown             █░░░░░░░░░░░░░░░░░░░░░░░     550 (3.0%)    8 files

Largest Files
    820 lines    42.3KB  src/commands/run.ts
    645 lines    31.1KB  src/providers/ollama.ts
    410 lines    18.7KB  src/index.ts
    ...

Most Changed Files (90 days)
  ███████████████   42x  src/commands/run.ts
  ████████████░░░   35x  src/index.ts
  █████████░░░░░░   22x  src/providers/ollama.ts
  ...

Complexity Hotspots (branch density)
  28.5%  82 branches / 288 lines  src/commands/run.ts
  22.1%  44 branches / 199 lines  src/providers/ollama.ts
  18.3%  31 branches / 169 lines  src/config/loader.ts
  ...
```

### Sort languages by file count

```
jam stats --sort files
```

Rearranges the language table so the language with the most files appears first.

### Sort by total lines (including blanks and comments)

```
jam stats --sort lines
```

### Sort by comment density

```
jam stats --sort comment
```

Shows which languages have the most comments first.

### Output as JSON for CI or dashboards

```
jam stats --json
```

Returns a structured object:

```json
{
  "summary": {
    "files": 142,
    "lines": 24300,
    "code": 18450
  },
  "languages": [
    {
      "language": "TypeScript",
      "files": 85,
      "lines": 16200,
      "blank": 1800,
      "comment": 2000,
      "code": 12400
    }
  ],
  "largestFiles": [
    { "file": "src/commands/run.ts", "lines": 820, "bytes": 43315 }
  ],
  "churn": [
    { "file": "src/commands/run.ts", "commits": 42 }
  ],
  "complexityHotspots": [
    {
      "file": "src/commands/run.ts",
      "branches": 82,
      "lines": 288,
      "density": 0.2847
    }
  ]
}
```

### Track code growth over time in CI

```
jam stats --json | jq '.summary.code' >> metrics/loc-history.txt
```

### Find the top 5 most complex files

```
jam stats --json | jq '.complexityHotspots[:5][] | "\(.density * 100 | floor)% \(.file)"'
```

### Compare language breakdown between branches

```
git stash && jam stats --json > stats-main.json
git stash pop && jam stats --json > stats-feature.json
diff <(jq '.languages' stats-main.json) <(jq '.languages' stats-feature.json)
```

## Sections Explained

### Languages

Lines of code (LOC) by language, excluding blank lines and comments. The bar chart is scaled relative to the language with the most code. Up to 15 languages are shown.

### Largest Files

The 8 largest files by line count, with file size in KB or bytes.

### Most Changed Files

The 8 files with the highest number of commits in the last 90 days. High churn can indicate actively developed features, code that needs refactoring, or configuration that is frequently tweaked.

### Complexity Hotspots

The 8 files with the highest branch density, measured as the ratio of branching constructs (`if`, `else`, `switch`, `case`, `for`, `while`, `catch`, `&&`, `||`, `?`) to total lines. Files under 20 lines or with fewer than 5 branches are excluded to avoid false positives. Density above 30% is colored red, above 15% is yellow, and below 15% is green.

## Notes

- Files larger than 1 MB are excluded from all analysis to keep the command fast.
- Comment detection is approximate. It handles `//`, `#`, `--` single-line comments and `/* ... */` block comments but does not account for strings containing comment-like sequences.
- Complexity analysis is limited to common code extensions: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`.
- The churn section requires git history. In a shallow clone, results may be incomplete.
