# jam hash

Smart file and directory hashing with .gitignore awareness. Supports SHA256 (default), SHA1, and MD5. Can hash individual files, entire directories (deterministically), only dirty files, or verify checksums from a file. No AI provider required.

## Synopsis

```
jam hash [paths...] [options]
```

If no paths are given, the current directory (`.`) is hashed.

## Options

| Flag | Description |
|------|-------------|
| `--algo <algorithm>` | Hash algorithm: `sha256` (default), `sha1`, or `md5` |
| `--dirty` | Hash only git-modified files (staged + unstaged) |
| `--short` | Output truncated 12-character hashes |
| `--check <file>` | Verify hashes against a checksum file |
| `--json` | Output results as JSON |

## How It Works

**File hashing:** Reads the file contents and computes the hash digest.

**Directory hashing:** Walks the directory tree in sorted (deterministic) order. For each file, the relative path and file contents are both fed into the hash. This means renaming a file changes the directory hash, even if the contents are identical. Directories named `.git`, `node_modules`, and `.DS_Store` are always skipped. Files listed in `.gitignore` are also skipped.

**Dirty mode:** Runs `git diff --name-only` and `git diff --staged --name-only` to find modified files, then hashes each one. Deleted files are reported with the hash value `deleted`.

**Check mode:** Reads a checksum file where each line has the format `<hash> <path>`. Computes the current hash for each path and compares it to the expected value. Exits with code 0 if all match, 1 if any fail.

## Examples

### Hash a single file

```
jam hash src/index.ts
```

Output:

```
a1b2c3d4e5f6...  src/index.ts  (18.7KB)
```

### Hash multiple files

```
jam hash src/index.ts package.json tsconfig.json
```

Each file is printed on its own line with its full SHA256 hash.

### Hash an entire directory

```
jam hash src/
```

Output:

```
f8e7d6c5b4a3...  src/  (85 files, 142.3KB)
```

The hash covers all non-ignored files in the directory, including nested subdirectories.

### Hash the project root

```
jam hash
```

When no path is given, it defaults to `.` (the workspace root). This gives you a single hash representing the entire project's source content.

### Use short hashes

```
jam hash --short src/index.ts package.json
```

Output:

```
a1b2c3d4e5f6  src/index.ts  (18.7KB)
d4e5f6a1b2c3  package.json  (1.2KB)
```

### Use MD5 instead of SHA256

```
jam hash --algo md5 package-lock.json
```

### Show hashes of all dirty files

```
jam hash --dirty
```

Sample output:

```
Dirty Files

  a1b2c3d4e5f6...  src/commands/todo.ts
  deleted           src/old-file.ts
  f8e7d6c5b4a3...  package.json
```

### Create a checksum file

```
jam hash src/index.ts src/config/loader.ts package.json > checksums.txt
```

The output format is `<hash>  <path>`, compatible with the `--check` flag.

### Verify checksums from a file

```
jam hash --check checksums.txt
```

Output:

```
OK   src/index.ts
OK   src/config/loader.ts
FAIL package.json  expected a1b2c3d4e5f6... got d4e5f6a1b2c3...
```

Exits with code 1 if any file fails verification.

### Use as a CI cache key

```
CACHE_KEY=$(jam hash --short --algo sha256 package-lock.json)
echo "Cache key: $CACHE_KEY"
```

### Output as JSON

```
jam hash --json src/ package.json
```

```json
[
  {
    "path": "src/",
    "hash": "f8e7d6c5b4a39281...",
    "files": 85,
    "bytes": 145678
  },
  {
    "path": "package.json",
    "hash": "a1b2c3d4e5f67890...",
    "bytes": 1234
  }
]
```

### Hash dirty files as JSON

```
jam hash --dirty --json
```

```json
[
  { "file": "src/commands/todo.ts", "hash": "a1b2c3d4e5f6..." },
  { "file": "src/old-file.ts", "hash": "deleted" }
]
```

### Compare directory hashes between branches

```
MAIN_HASH=$(git stash && jam hash --short src/ && git stash pop)
FEAT_HASH=$(jam hash --short src/)
[ "$MAIN_HASH" = "$FEAT_HASH" ] && echo "No source changes" || echo "Source changed"
```

## Notes

- Directory hashing includes relative file paths in the hash computation, so renaming or moving a file changes the hash even if the file contents are unchanged. This is intentional for cache invalidation use cases.
- The sort order for directory traversal is `localeCompare`-based, ensuring deterministic results across runs on the same platform.
- `.gitignore` patterns are resolved via `git ls-files --others --ignored --exclude-standard`, so the command must be run inside a git repository for ignore rules to apply. Outside a git repo, no files are skipped by ignore rules.
- The `--check` flag supports both full and short hashes. It uses a prefix match, so a checksum file generated with `--short` will verify correctly.
- `--dirty` mode requires a git repository. It reports files that differ from HEAD (both staged and unstaged changes).
