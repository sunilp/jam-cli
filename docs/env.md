# jam env

Manage `.env` files. List environment files, diff against `.env.example`, find empty variables, redact secrets for safe sharing, and validate formatting. No AI provider required.

## Synopsis

```
jam env [options]
```

## Options

| Flag | Description |
|------|-------------|
| `--diff` | Compare `.env` against the example file and show missing/extra variables |
| `--missing` | Show variables that have empty values |
| `--redact` | Print the `.env` file with secret values masked |
| `--validate` | Check for formatting issues (duplicates, naming, empty secrets, unquoted spaces) |
| `--file <path>` | Specify which env file to inspect (default: `.env`) |
| `--example <path>` | Specify the example file for `--diff` mode |
| `--json` | Output results as JSON (works with all modes) |

## Modes

When run without `--diff`, `--missing`, `--redact`, or `--validate`, the command operates in **list mode**: it scans the project root for all files starting with `.env` and shows a summary of each.

## Auto-Detection

The example file is auto-detected by checking for these filenames in order:

1. `.env.example`
2. `.env.sample`
3. `.env.template`
4. `.env.defaults`

You can override this with `--example <path>`.

## Secret Detection

Variables are classified as secrets if their key matches any of these patterns (case-insensitive):

`password`, `secret`, `token`, `key`, `api_key`, `private`, `credential`, `auth`, `jwt`, `bearer`, `connection_string`, `database_url`, `dsn`

Secret detection is used in list mode (to count secrets), redact mode (to mask values), and validate mode (to flag empty secrets).

## Examples

### List all .env files in the project

```
jam env
```

Sample output:

```
Environment Files

  .env                    12 vars  3 secrets  1 empty
  .env.example            12 vars
  .env.local               4 vars  2 secrets
  .env.test                8 vars  1 secrets

Tip: jam env --diff to compare .env vs example, --missing to find gaps
```

### Diff .env against .env.example

```
jam env --diff
```

Sample output:

```
Env Diff: .env vs .env.example

Missing (in .env.example but not .env)
  - REDIS_URL         # Redis connection string
  - SENTRY_DSN        # Error tracking

Extra (in .env but not .env.example)
  + DEBUG_MODE
  + LEGACY_API_KEY
```

### Diff a custom env file against a custom example

```
jam env --diff --file .env.staging --example .env.production
```

### Find variables with empty values

```
jam env --missing
```

Sample output:

```
Empty Variables (3)

  DATABASE_URL   line 5  # PostgreSQL connection string
  API_SECRET     line 12
  REDIS_URL      line 18  # Redis connection string
```

### Redact secrets for sharing

```
jam env --redact
```

Sample output:

```
# Redacted .env
NODE_ENV=development
PORT=3000
DATABASE_URL=po****ql://user:****@localhost:5432/mydb
API_KEY=sk**********9f
API_SECRET=wh****Bx
JWT_SECRET=my****et
DEBUG=true
```

Values that look like booleans (`true`/`false`) or simple numbers (`0`/`1`) are not redacted. URL passwords are detected and masked independently. All other secret-pattern matches have their middle characters replaced with asterisks.

### Redirect redacted output to a file for sharing

```
jam env --redact > .env.redacted
```

### Validate .env formatting

```
jam env --validate
```

Sample output:

```
Validation Issues (4)

  L3  DATABASE_URL -- empty secret
  L7  api-key -- non-standard key format
  L12 API_KEY -- duplicate key
  L15 APP_NAME -- unquoted value with spaces
```

The command checks for:
- **Duplicate keys**: the same variable name appears more than once.
- **Non-standard naming**: keys that are not all-uppercase with underscores (`MY_VAR`) or all-lowercase with underscores (`my_var`). Mixed case or hyphens trigger this warning.
- **Empty secrets**: variables whose key matches a secret pattern but whose value is empty.
- **Unquoted spaces**: values that contain spaces but are not wrapped in quotes.

The exit code is 1 if any empty secrets are found, 0 otherwise.

### Validate and output as JSON

```
jam env --validate --json
```

```json
[
  { "line": 3, "key": "DATABASE_URL", "issue": "empty secret" },
  { "line": 7, "key": "api-key", "issue": "non-standard key format" },
  { "line": 12, "key": "API_KEY", "issue": "duplicate key" },
  { "line": 15, "key": "APP_NAME", "issue": "unquoted value with spaces" }
]
```

### Diff as JSON for CI checks

```
jam env --diff --json
```

```json
{
  "missing": ["REDIS_URL", "SENTRY_DSN"],
  "extra": ["DEBUG_MODE", "LEGACY_API_KEY"],
  "common": ["NODE_ENV", "PORT", "DATABASE_URL", "API_KEY", "API_SECRET"]
}
```

### Redact as JSON

```
jam env --redact --json
```

```json
{
  "NODE_ENV": "development",
  "PORT": "3000",
  "DATABASE_URL": "po****ql://user:****@localhost:5432/mydb",
  "API_KEY": "sk**********9f",
  "JWT_SECRET": "my****et"
}
```

### Fail CI if .env is missing required variables

```
MISSING=$(jam env --diff --json | jq '.missing | length')
if [ "$MISSING" -gt 0 ]; then
  echo "Missing $MISSING required env vars"
  jam env --diff
  exit 1
fi
```

### Check for empty secrets in a pre-commit hook

```
jam env --validate --json | jq -e '[.[] | select(.issue == "empty secret")] | length == 0'
```

## Notes

- The list mode scans only the project root directory for files whose names start with `.env`. It does not recurse into subdirectories.
- Quoted values (single or double quotes) are stripped before analysis. `MY_VAR="hello"` and `MY_VAR=hello` are treated the same way.
- Comment lines (starting with `#`) are preserved as context. A comment immediately above a variable is associated with that variable and shown in diff and missing output.
- The `--file` flag defaults to `.env`. It is relative to the project root (git workspace root, or current directory if not in a git repo).
- When `--diff` is used without an example file and none of the auto-detected candidates exist, the command exits with an error.
