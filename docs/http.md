# jam http -- Quick HTTP Client

A quick HTTP client with pretty output. Like curl but with auto JSON
formatting, colored status codes, and timing. Uses Node.js built-in `fetch`
(Node 20+) with zero external dependencies. This is a zero-LLM command; it
works without any AI provider configured.

## Synopsis

```
jam http [method] <url> [options]
```

When `method` is omitted, GET is assumed. The URL must start with `http://` or
`https://`.

## Options

| Flag | Short | Description |
|------|-------|-------------|
| `--header <header>` | `-H` | Request header, repeatable (e.g. `"Content-Type: application/json"`) |
| `--body <data>` | `-d` | Request body; prefix with `@` to read from file |
| `--bearer <token>` | | Set `Authorization: Bearer <token>` header |
| `--json` | | Force JSON output formatting |
| `--timing` | | Show request timing and response size |
| `--verbose` | `-v` | Show response headers |
| `--output <file>` | `-o` | Save response body to a file |
| `--no-color` | | Disable colored output |

## Status Code Colors

- 2xx: green
- 3xx: yellow
- 4xx: orange
- 5xx: red

The process exits with code 1 for 4xx and 5xx status codes.

## Examples

### 1. Simple GET request

```
jam http https://api.github.com/repos/octocat/hello-world
```

Output:

```
200 OK GET https://api.github.com/repos/octocat/hello-world 234ms
{
  "id": 1296269,
  "name": "Hello-World",
  "full_name": "octocat/Hello-World",
  "description": "My first repository on GitHub!",
  "stargazers_count": 2345
}
```

JSON responses are automatically detected via Content-Type and pretty-printed
with syntax coloring.

### 2. Explicit method

```
jam http GET https://httpbin.org/get
```

### 3. POST with JSON body

```
jam http POST https://api.example.com/users --body '{"name": "Alice", "email": "alice@example.com"}'
```

Content-Type is auto-detected as `application/json` when the body parses as
valid JSON. Otherwise it defaults to `text/plain`.

### 4. POST with body from file

Use the `@` prefix to read the request body from a file:

```
jam http POST https://api.example.com/import --body @data.json
```

### 5. POST with stdin body

Pipe data into a POST/PUT/PATCH request:

```
echo '{"key": "value"}' | jam http POST https://api.example.com/data
```

```
cat payload.json | jam http PUT https://api.example.com/resource/123
```

Stdin body is only read for POST, PUT, and PATCH methods.

### 6. Custom headers

Add one or more headers with `-H` or `--header`:

```
jam http GET https://api.example.com/data \
  -H "Accept: application/xml" \
  -H "X-Request-Id: abc123"
```

### 7. Bearer token authentication

```
jam http GET https://api.example.com/me --bearer eyJhbGciOiJIUzI1NiJ9...
```

This sets the header `Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...`.

### 8. Verbose mode with response headers

```
jam http GET https://httpbin.org/get --verbose
```

Output:

```
200 OK GET https://httpbin.org/get 187ms

Response Headers
  content-type: application/json
  content-length: 256
  server: gunicorn/19.9.0
  access-control-allow-origin: *

{
  "url": "https://httpbin.org/get",
  "headers": { ... }
}
```

### 9. Show timing and size details

```
jam http GET https://api.github.com/zen --timing
```

Output:

```
200 OK GET https://api.github.com/zen 312ms
Responsive design is not a luxury.

Timing:
  Total: 312ms
  Size:  38 bytes
```

### 10. Save response to a file

```
jam http GET https://api.example.com/report --output report.json
```

Output:

```
200 OK GET https://api.example.com/report 445ms
Body saved to report.json
```

### 11. Force JSON formatting

When the response Content-Type is not `application/json` but the body is
actually JSON, use `--json` to force pretty formatting:

```
jam http GET https://example.com/api/data --json
```

### 12. Disable color for scripting

```
jam http GET https://api.example.com/status --no-color
```

### 13. Chain with other jam commands

Fetch and query JSON:

```
jam http GET https://api.github.com/repos/octocat/hello-world > /tmp/repo.json
jam json /tmp/repo.json --query "stargazers_count"
```

### 14. Use exit code in scripts

```bash
if jam http GET https://api.example.com/health > /dev/null 2>&1; then
  echo "Service is healthy"
else
  echo "Service returned an error"
fi
```

The exit code is 1 for any 4xx or 5xx response, and 0 otherwise.

## Content-Type Auto-Detection

When sending a request body (via `--body` or stdin) and no `Content-Type`
header is set:

- If the body parses as valid JSON: `application/json`
- Otherwise: `text/plain`

## Error Handling

- Network errors (DNS failure, connection refused, timeout) print the error
  message to stderr and exit with code 1.
- If `--body @filename` references a file that cannot be read, an error is
  printed and the process exits with code 1.
- HTTP 4xx/5xx responses still print the body but set exit code 1.

## Notes

- Status line and headers are printed to stderr; the response body is printed
  to stdout. This makes it safe to redirect the body without capturing status
  information.
- Request timing measures the full round-trip from `fetch()` call to response
  body read.
- The `--header` flag is repeatable: use it multiple times for multiple headers.
