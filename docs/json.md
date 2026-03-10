# jam json -- JSON Swiss Knife

Pretty print, query, diff, minify, sort, and flatten JSON data. Reads from a
file or stdin. This is a zero-LLM command; it works without any AI provider
configured.

## Synopsis

```
jam json [file] [options]
```

When `file` is omitted, reads JSON from stdin.

## Options

| Flag | Description |
|------|-------------|
| `--query <path>` | Extract a value by dot-path (supports array indices) |
| `--diff <file>` | Deep diff against another JSON file |
| `--minify` | Output minified (compact) JSON |
| `--sort-keys` | Sort object keys alphabetically (recursive) |
| `--flatten` | Flatten nested structure to dot-notation key paths |
| `--no-color` | Disable syntax coloring |

## Syntax Coloring

By default, output is syntax-colored:

- Keys: cyan
- Strings: green
- Numbers: yellow
- Booleans: magenta
- Null: dim

Use `--no-color` or pipe to another command (color is typically auto-disabled
when stdout is not a TTY in most terminal setups).

## Examples

### 1. Pretty print a JSON file

```
jam json data.json
```

Output (with colors in terminal):

```json
{
  "name": "jam-cli",
  "version": "0.4.0",
  "dependencies": {
    "chalk": "^5.3.0",
    "commander": "^12.0.0"
  }
}
```

### 2. Pretty print from stdin

```
curl -s https://api.example.com/users | jam json
```

Or:

```
echo '{"a":1,"b":{"c":2}}' | jam json
```

### 3. Query a nested value with dot-path

Use dot notation with array index support:

```
jam json config.json --query "database.host"
```

Output:

```
localhost
```

Array access:

```
jam json users.json --query "users[0].name"
```

Output:

```
Alice
```

Nested arrays:

```
jam json data.json --query "teams[2].members[0].email"
```

When the query result is an object or array, it is output as formatted JSON.
When it is a primitive, the raw value is printed.

### 4. Diff two JSON files

```
jam json old-config.json --diff new-config.json
```

Output:

```
JSON Diff (3 changes)

  + settings.newFeature: true
  - settings.deprecated: "old-value"
  ~ settings.timeout: 30 -> 60
```

The diff is deep and recursive. It reports:
- `+` added paths (present in second file, absent in first)
- `-` removed paths (present in first file, absent in second)
- `~` changed values (present in both, different values)

Array elements are compared by index.

### 5. Minify JSON

Strip whitespace for compact output:

```
jam json data.json --minify
```

Output:

```
{"name":"jam-cli","version":"0.4.0","dependencies":{"chalk":"^5.3.0"}}
```

Useful for piping into other tools or reducing file size:

```
jam json large.json --minify > large.min.json
```

### 6. Sort keys recursively

Alphabetize all object keys at every nesting level:

```
jam json package.json --sort-keys
```

This is useful for normalizing JSON before committing, comparing, or diffing.
Combine with `--minify` for a canonical form:

```
jam json data.json --sort-keys --minify
```

### 7. Flatten nested JSON

Convert a deeply nested structure into flat dot-notation paths:

```
jam json config.json --flatten
```

Input:

```json
{
  "database": {
    "host": "localhost",
    "ports": [5432, 5433]
  },
  "debug": true
}
```

Output:

```json
{
  "database.host": "localhost",
  "database.ports[0]": 5432,
  "database.ports[1]": 5433,
  "debug": true
}
```

### 8. Pipe from other commands

Process API responses:

```
curl -s https://api.github.com/repos/owner/repo | jam json --query "stargazers_count"
```

Process command output:

```
npm ls --json | jam json --query "dependencies"
```

### 9. Combine sort-keys with pretty print for clean output

```
cat unsorted.json | jam json --sort-keys
```

### 10. Disable color for redirection

```
jam json data.json --no-color > formatted.json
```

## Error Handling

- If the input is not valid JSON, an error message is printed to stderr with
  the parse error details, and the process exits with code 1.
- If a `--query` path does not exist, "Path not found" is printed to stderr
  and the process exits with code 1.
- If `--diff <file>` cannot be read or parsed, an error is printed to stderr.

## Notes

- The `--query` path syntax uses dots for object access and brackets for array
  indices: `foo.bar[0].baz`. Brackets are internally converted to dots, so
  `foo.bar.0.baz` also works.
- `--flatten` and `--minify` are mutually exclusive in practice: flatten always
  outputs pretty-printed JSON.
- `--sort-keys` can be combined with `--minify` or default pretty print, but
  not with `--flatten` or `--query` (sort-keys is applied before serialization,
  flatten and query operate independently).
