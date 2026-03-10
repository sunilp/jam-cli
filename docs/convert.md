# jam convert -- Format Converter Swiss Knife

Convert between data formats: JSON, YAML, CSV, Base64, URL encoding, and Hex.
Auto-detects input format from file extension or content. Reads from a file or
stdin. This is a zero-LLM command; it works without any AI provider configured.

## Synopsis

```
jam convert [file] [options]
```

When `file` is omitted, reads from stdin.

## Options

| Flag | Description |
|------|-------------|
| `--from <format>` | Input format (auto-detected if omitted) |
| `--to <format>` | Output format |

### Format Names and Aliases

| Format | Accepted names |
|--------|---------------|
| JSON | `json` |
| YAML | `yaml`, `yml` |
| CSV | `csv`, `tsv` |
| Base64 | `base64`, `b64` |
| URL encoding | `url`, `urlencode`, `percent` |
| Hex | `hex` |

## Auto-Detection

When `--from` is omitted, the input format is detected in this order:

1. File extension (`.json`, `.yaml`, `.yml`, `.csv`, etc.)
2. Content inspection: JSON (starts with `{` or `[`), Base64 (only base64
   characters), URL-encoded (contains `%XX`), Hex (only hex digits), CSV
   (commas on multiple lines), YAML (contains colons)

When `--from` is an encoding format (`base64`, `url`, `hex`) and `--to` is
omitted, the input is decoded to plain text automatically.

## Examples

### 1. JSON to YAML

```
jam convert config.json --to yaml
```

Input (`config.json`):

```json
{
  "database": {
    "host": "localhost",
    "port": 5432
  },
  "debug": true
}
```

Output:

```yaml
database:
  host: localhost
  port: 5432
debug: true
```

### 2. YAML to JSON

```
jam convert config.yaml --to json
```

Output:

```json
{
  "database": {
    "host": "localhost",
    "port": 5432
  },
  "debug": true
}
```

### 3. CSV to JSON

```
jam convert users.csv --to json
```

Input (`users.csv`):

```
name,email,role
Alice,alice@example.com,admin
Bob,bob@example.com,user
```

Output:

```json
[
  { "name": "Alice", "email": "alice@example.com", "role": "admin" },
  { "name": "Bob", "email": "bob@example.com", "role": "user" }
]
```

The CSV parser handles quoted fields and escaped quotes:

```
name,description
Alice,"She said ""hello"""
Bob,"Line 1, line 2"
```

### 4. JSON to CSV

```
jam convert users.json --to csv
```

The input must be an array of objects. Keys from the first object become the
CSV header row.

### 5. Base64 encode

```
echo "hello world" | jam convert --to base64
```

Output:

```
aGVsbG8gd29ybGQK
```

From a file:

```
jam convert secret.txt --to base64
```

### 6. Base64 decode

```
echo "aGVsbG8gd29ybGQ=" | jam convert --from base64
```

Output:

```
hello world
```

When `--from base64` is used without `--to`, the output is plain text. If
`--to json` or `--to yaml` is specified, the decoded content is parsed as
structured data:

```
echo "eyJrZXkiOiAidmFsdWUifQ==" | jam convert --from base64 --to json
```

Output:

```json
{
  "key": "value"
}
```

### 7. URL encode and decode

Encode:

```
echo "hello world & goodbye" | jam convert --to url
```

Output:

```
hello%20world%20%26%20goodbye
```

Decode:

```
echo "hello%20world%20%26%20goodbye" | jam convert --from url
```

Output:

```
hello world & goodbye
```

### 8. Hex encode and decode

Encode:

```
echo "hello" | jam convert --to hex
```

Output:

```
68656c6c6f0a
```

Decode:

```
echo "68656c6c6f" | jam convert --from hex
```

Output:

```
hello
```

### 9. Pipe between formats

Convert a YAML API response to JSON:

```
curl -s https://raw.githubusercontent.com/owner/repo/main/config.yaml | jam convert --from yaml --to json
```

Convert JSON API output to CSV:

```
curl -s https://api.example.com/users | jam convert --from json --to csv
```

### 10. Explicit format override

When auto-detection picks the wrong format, specify `--from` explicitly:

```
jam convert ambiguous-file.txt --from yaml --to json
```

## Error Handling

- If the input file cannot be read, an error is printed to stderr with code 1.
- If the input cannot be parsed as the detected/specified format, a format-
  specific error is printed (e.g., "Invalid JSON: Unexpected token...").
- If `--to` is omitted and the input is not an encoding format, the message
  "Specify output format with --to" is shown.
- CSV output requires an array of objects; other input shapes produce an error.

## Notes

- YAML parsing and serialization uses the `js-yaml` library.
- YAML output uses 2-space indentation and a 120-character line width.
- CSV output escapes fields containing commas, quotes, or newlines by wrapping
  them in double quotes and doubling any internal quotes.
- Hex decoding strips whitespace from input before converting, so both
  `68656c6c6f` and `68 65 6c 6c 6f` are accepted.
