# jam recent

Show recently modified files based on git commit activity. Files are grouped by time period (Today, This Week, Earlier) and ranked by commit frequency with a visual bar chart. Answers the question "what was I working on?" No AI provider required.

## Synopsis

```
jam recent [options]
```

## Options

| Flag | Description |
|------|-------------|
| `--days <n>` | Lookback period in days (default: 7) |
| `--author <name>` | Filter commits to a specific git author |
| `--limit <n>` | Maximum number of files to show (default: 30) |
| `--json` | Output results as JSON |

## How It Works

1. Runs `git log --since="<n> days ago" --name-only` to collect all file changes in the time window.
2. Counts how many commits touched each file.
3. Tracks all contributing authors per file.
4. Sorts files by commit frequency (descending), then by recency as a tiebreaker.
5. Groups results into Today, This Week, and Earlier buckets.
6. Renders a bar chart where bar length is proportional to the most-changed file.

## Examples

### Show files changed in the last 7 days (default)

```
jam recent
```

Sample output:

```
Recently Modified Files (last 7 days)

Today
  ███████████████  12x  src/commands/todo.ts
  ██████████░░░░░   8x  src/index.ts
  ████░░░░░░░░░░░   3x  src/commands/ports.ts

This Week
  █████████████░░  10x  src/providers/ollama.ts [alice, bob]
  ██████░░░░░░░░░   5x  src/config/loader.ts
  ███░░░░░░░░░░░░   2x  package.json

Earlier
  ████░░░░░░░░░░░   3x  README.md

47 files changed, 92 total commits
```

### Extend the lookback window to 30 days

```
jam recent --days 30
```

Shows all file activity from the last 30 days.

### Filter to a specific author

```
jam recent --author alice
```

Shows only files changed by commits where the author name matches "alice". The match is a substring match performed by `git log --author`.

### Limit the number of results

```
jam recent --limit 10
```

Caps the output at the 10 most frequently changed files.

### Output as JSON for scripting

```
jam recent --json
```

Returns an array of objects:

```json
[
  {
    "file": "src/commands/todo.ts",
    "commits": 12,
    "lastModified": "2026-03-10 14:22:01 -0700",
    "authors": ["alice"]
  },
  {
    "file": "src/index.ts",
    "commits": 8,
    "lastModified": "2026-03-10 09:15:33 -0700",
    "authors": ["alice", "bob"]
  }
]
```

### Find the most active files in the last 90 days

```
jam recent --days 90 --limit 20
```

Useful for identifying long-running hotspots in the codebase.

### Identify files where multiple authors are collaborating

```
jam recent --days 14 --json | jq '[.[] | select(.authors | length > 1)]'
```

### Get a quick summary of your own recent activity

```
jam recent --author "$(git config user.name)" --days 3
```

Shows only the files you personally changed in the last 3 days.

## Notes

- The command requires a git repository. It will exit with an error if run outside one or if there are no commits in the specified time window.
- The `--author` flag is passed directly to `git log --author`, which performs a substring match on the author name. Partial names work (e.g., `--author ali` matches "alice").
- Files are sorted primarily by commit count. When two files have the same commit count, the more recently modified file appears first.
- The bar chart uses a fixed width of 15 characters. The file with the highest commit count gets a full bar; all others are scaled proportionally.
- Each file entry lists all contributing authors when more than one person has committed changes to it.
