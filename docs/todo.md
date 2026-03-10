# jam todo

Scan your codebase for TODO, FIXME, HACK, XXX, NOTE, WARN, BUG, OPTIMIZE, and REVIEW comments. Results are grouped by type with colored output. No AI provider required -- this command runs entirely on regex matching and git.

## Synopsis

```
jam todo [options]
```

## Options

| Flag | Description |
|------|-------------|
| `--by-author` | Group results by git author (uses `git blame`) |
| `--by-age` | Sort results by age, oldest first (uses `git blame`) |
| `--type <types...>` | Filter to specific comment types |
| `--pattern <regex>` | Scan for a custom regex pattern instead of the defaults |
| `--json` | Output results as JSON |

## How It Works

1. Uses `git ls-files --cached --others --exclude-standard` to discover files (respects `.gitignore`).
2. Skips binary files (images, fonts, archives, PDFs, executables, lock files).
3. Skips `node_modules/`, `dist/`, and `.git/` directories.
4. Matches each line against the pattern `\b(TODO|FIXME|HACK|XXX|NOTE|WARN|BUG|OPTIMIZE|REVIEW)\b[:\s-]*(.*)`.
5. When `--by-author` or `--by-age` is set, enriches each hit with `git blame` data (author name and timestamp).

## Default Comment Types

Each type is displayed in a distinct color:

| Type | Color |
|------|-------|
| TODO | Yellow |
| FIXME | Red |
| HACK | Magenta |
| XXX | Bold red |
| BUG | Bold red |
| NOTE | Blue |
| WARN | Orange |
| OPTIMIZE | Cyan |
| REVIEW | Green |

## Examples

### Scan the entire codebase for all comment types

```
jam todo
```

Sample output:

```
Found 14 items  TODO: 7  FIXME: 4  HACK: 2  NOTE: 1

TODO (7)
  src/config/loader.ts:42
    support nested profile inheritance
  src/providers/ollama.ts:118
    retry on 503 Service Unavailable
  ...

FIXME (4)
  src/commands/run.ts:87
    token budget not enforced
  ...
```

### Filter to only TODO and FIXME comments

```
jam todo --type TODO --type FIXME
```

This ignores HACK, XXX, NOTE, and every other type, showing only TODO and FIXME entries.

### Group results by git author

```
jam todo --by-author
```

Sample output:

```
alice (5)
  TODO     src/config/loader.ts:42         3mo ago
           support nested profile inheritance
  FIXME    src/commands/run.ts:87           12 days ago
           token budget not enforced

bob (9)
  HACK     src/providers/ollama.ts:55       1y ago
           workaround for broken chunked encoding
  ...
```

### Sort by age to find the oldest comments

```
jam todo --by-age
```

The oldest items appear first. This is useful for triaging stale TODOs that have been sitting in the codebase for months or years.

### Scan for a custom pattern

```
jam todo --pattern "DEPRECATED|LEGACY"
```

This replaces the default pattern and scans for lines matching `\b(DEPRECATED|LEGACY)\b[:\s-]*(.*)`.

### Output as JSON for scripting

```
jam todo --json
```

Returns an array of objects:

```json
[
  {
    "file": "src/config/loader.ts",
    "line": 42,
    "type": "TODO",
    "text": "support nested profile inheritance"
  },
  {
    "file": "src/commands/run.ts",
    "line": 87,
    "type": "FIXME",
    "text": "token budget not enforced"
  }
]
```

### Combine author enrichment with JSON output

```
jam todo --by-author --json
```

Each object includes `author` and `age` fields:

```json
[
  {
    "file": "src/config/loader.ts",
    "line": 42,
    "type": "TODO",
    "text": "support nested profile inheritance",
    "author": "alice",
    "age": "3mo ago"
  }
]
```

### Count TODOs per type in a CI pipeline

```
jam todo --json | jq 'group_by(.type) | map({type: .[0].type, count: length})'
```

### Find all FIXMEs by a specific author

```
jam todo --by-author --type FIXME --json | jq '[.[] | select(.author == "alice")]'
```

## Notes

- Files larger than the system read buffer or that fail to decode as UTF-8 are silently skipped.
- Uncommitted lines (not yet tracked by git) will show `author: "uncommitted"` and `age: "new"` when blame enrichment is active.
- The `--by-age` flag sorts from oldest to newest. When combined with `--by-author`, items are still sorted by age within each author group.
- The `--pattern` flag replaces the entire default pattern. The regex is automatically wrapped as `\b(<your pattern>)\b[:\s-]*(.*)` with the global and case-insensitive flags.
