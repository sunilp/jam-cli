# jam dup -- Near-Duplicate Code Detection

Detect near-duplicate code blocks across your project. Uses token-based
similarity with a rolling hash (Rabin fingerprint) to catch copy-paste debt --
not just exact matches. This is a zero-LLM command; it works without any AI
provider configured.

## Synopsis

```
jam dup [options]
```

## Options

| Flag | Description | Default |
|------|-------------|---------|
| `--min-lines <n>` | Minimum block size in source lines | 6 |
| `--threshold <n>` | Similarity threshold from 0 to 1 | 0.8 (80%) |
| `--glob <pattern>` | Limit to files matching a glob pattern | all code files |
| `--limit <n>` | Maximum number of duplicates to report | 20 |
| `--json` | Output results as JSON | off |

## How It Works

**Phase 1 -- Hash grouping (cheap).** Source files are tokenized with comments
stripped. A sliding window of tokens moves across each file, computing a rolling
polynomial hash per window. Blocks with the same hash are grouped as candidate
pairs.

**Phase 2 -- Jaccard verification (accurate).** Candidate pairs are verified
using Jaccard set similarity on their token sets. Only pairs that meet the
`--threshold` are reported. Overlapping reports within the same file region are
de-duplicated.

The tokenizer handles block comments (`/* ... */`), line comments (`//` and `#`
for Python/Ruby), and normalizes whitespace, so cosmetic differences like
reformatting or comment changes do not prevent detection.

## Supported Languages

TypeScript, JavaScript, Python, Go, Rust, Java, C, C++, C#, Ruby, PHP, Swift
(14 languages via file extension: `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`,
`.rs`, `.java`, `.c`, `.cpp`, `.cs`, `.rb`, `.php`, `.swift`).

Files in `node_modules/`, `dist/`, and `vendor/` are always excluded.
Minified files (`.min.js`, `.min.css`) and declaration files (`.d.ts`) are also
skipped.

## Examples

### 1. Scan the entire project with defaults

```
jam dup
```

Output:

```
Scanning 42 files for duplicates...

Duplicate Code Blocks (5 found, threshold 80%)

  #1 97% similar  (12 lines)
    src/commands/ask.ts:45-56
    src/commands/explain.ts:32-43

  #2 93% similar  (8 lines)
    src/tools/read_file.ts:18-25
    src/tools/list_dir.ts:22-29

  #3 85% similar  (9 lines)
    src/providers/ollama.ts:60-68
    src/providers/anthropic.ts:55-63

  #4 82% similar  (7 lines)
    src/utils/errors.ts:30-36
    src/utils/stream.ts:44-50

  #5 80% similar  (6 lines)
    src/commands/diff.ts:15-20
    src/commands/patch.ts:18-23
```

### 2. Only report highly similar blocks

Raise the threshold to 95% to find near-exact copies:

```
jam dup --threshold 0.95
```

### 3. Set a larger minimum block size

Only report duplicates of 15 or more lines:

```
jam dup --min-lines 15
```

This reduces noise from small common patterns (error handling, boilerplate
imports) and surfaces larger structural duplications.

### 4. Limit to TypeScript files

Use `--glob` to restrict the scan to a specific file pattern:

```
jam dup --glob "*.ts"
```

Or target a specific directory:

```
jam dup --glob "src/commands/*.ts"
```

### 5. Get more results

By default only the top 20 duplicates are shown. Request more:

```
jam dup --limit 50
```

### 6. JSON output for tooling

```
jam dup --json
```

Output:

```json
[
  {
    "blockA": { "file": "src/commands/ask.ts", "startLine": 45, "endLine": 56 },
    "blockB": { "file": "src/commands/explain.ts", "startLine": 32, "endLine": 43 },
    "lines": 12,
    "similarity": 0.97
  },
  {
    "blockA": { "file": "src/tools/read_file.ts", "startLine": 18, "endLine": 25 },
    "blockB": { "file": "src/tools/list_dir.ts", "startLine": 22, "endLine": 29 },
    "lines": 8,
    "similarity": 0.93
  }
]
```

### 7. Combine options for a targeted scan

Look for large, high-confidence duplicates in Python files only:

```
jam dup --glob "*.py" --min-lines 10 --threshold 0.9 --limit 5
```

### 8. Use in CI to enforce duplication limits

```bash
count=$(jam dup --threshold 0.95 --json | jq 'length')
if [ "$count" -gt 0 ]; then
  echo "ERROR: $count near-exact duplicate blocks found"
  jam dup --threshold 0.95
  exit 1
fi
```

## Notes

- Requires a git repository (uses `git ls-files` to discover source files)
- The token window size is approximately `min-lines * 3` tokens, based on the
  heuristic of roughly 3 tokens per source line
- Same-file overlapping blocks (blocks closer than `--min-lines` apart) are not
  reported as duplicates
- Results are sorted by similarity (highest first), then by block size
- When no duplicates are found, the output is: `No significant code duplication found.`
