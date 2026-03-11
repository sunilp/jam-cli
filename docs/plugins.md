# Jam Plugin System

Extend Jam with custom commands by dropping plugin directories into
`~/.jam/plugins/` or your project's `.jam/plugins/`. Plugins register
Commander.js commands and have access to workspace context and UI helpers.

## Quick Start

### 1. Create the plugin directory

```bash
mkdir -p ~/.jam/plugins/my-plugin
```

### 2. Create the manifest

```bash
cat > ~/.jam/plugins/my-plugin/jam-plugin.json << 'EOF'
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "My custom jam command",
  "commands": ["greet"]
}
EOF
```

### 3. Create the entry point

```bash
cat > ~/.jam/plugins/my-plugin/index.js << 'EOF'
export function register(program, context) {
  program
    .command('greet [name]')
    .description('Say hello')
    .action((name) => {
      console.log(`Hello, ${name || 'world'}! (workspace: ${context.workspaceRoot})`);
    });
}
EOF
```

### 4. Verify

```bash
jam plugin list    # shows your plugin
jam greet Alice    # runs it
```

## Plugin Structure

```
~/.jam/plugins/my-plugin/
├── jam-plugin.json     # manifest (required)
├── index.js            # entry point (required, ESM)
├── package.json        # optional, for npm dependencies
└── node_modules/       # optional, plugin's own dependencies
```

## Manifest (`jam-plugin.json`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique plugin name (kebab-case, e.g. `my-plugin`) |
| `version` | string | Yes | Semver version |
| `description` | string | No | Short description shown in `jam plugin list` |
| `commands` | string[] | No | Command names this plugin registers (for conflict detection) |

## Entry Point (`index.js`)

Must be an ES module that exports a `register` function:

```javascript
/**
 * @param {import('commander').Command} program - The Commander.js program instance
 * @param {PluginContext} context - Workspace and UI helpers
 */
export function register(program, context) {
  // Register one or more commands
  program
    .command('my-command')
    .description('Does something')
    .action(async () => {
      // Your logic here
    });
}
```

### Plugin Context

The `context` object provides:

| Property | Type | Description |
|----------|------|-------------|
| `context.workspaceRoot` | string | Git root or current working directory |
| `context.ui.printError(msg, hint?)` | function | Print styled error to stderr |
| `context.ui.printWarning(msg)` | function | Print styled warning to stderr |
| `context.ui.printSuccess(msg)` | function | Print styled success to stderr |

## Plugin Discovery

Plugins are loaded from these directories (in order):

1. `~/.jam/plugins/` — user-level plugins (always scanned)
2. `.jam/plugins/` — project-level plugins (in git root)
3. Paths from `pluginDirs` config — additional custom directories

The first plugin found with a given name wins (deduplication by name).

## Configuration

Control plugin loading in `.jamrc` or `~/.jam/config.json`:

```json
{
  "pluginDirs": ["/path/to/extra/plugins"],
  "enabledPlugins": ["my-plugin"],
  "disabledPlugins": ["unwanted-plugin"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `pluginDirs` | string[] | Additional directories to scan for plugins |
| `enabledPlugins` | string[] | Only load these plugins (allowlist). Empty = load all. |
| `disabledPlugins` | string[] | Never load these plugins (denylist). |

## Managing Plugins

```bash
jam plugin list          # show all installed plugins and their status
jam plugin list --json   # machine-readable output
```

## Examples

### BigQuery Plugin

```bash
mkdir -p ~/.jam/plugins/bigquery
cd ~/.jam/plugins/bigquery
npm init -y
npm install @google-cloud/bigquery
```

`jam-plugin.json`:
```json
{
  "name": "bigquery",
  "version": "1.0.0",
  "description": "Query BigQuery from the terminal",
  "commands": ["bq"]
}
```

`index.js`:
```javascript
import { BigQuery } from '@google-cloud/bigquery';

export function register(program) {
  const bq = program.command('bq').description('BigQuery utilities');

  bq.command('query <sql>')
    .description('Run a SQL query')
    .option('--project <id>', 'GCP project ID')
    .option('--json', 'raw JSON output')
    .action(async (sql, opts) => {
      const client = new BigQuery({ projectId: opts.project });
      const [rows] = await client.query({ query: sql });
      if (opts.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      } else {
        console.table(rows);
      }
    });

  bq.command('tables <dataset>')
    .description('List tables in a dataset')
    .action(async (dataset) => {
      const client = new BigQuery();
      const [tables] = await client.dataset(dataset).getTables();
      tables.forEach((t) => console.log(`  ${t.id}`));
    });
}
```

Usage:
```bash
jam bq query "SELECT * FROM dataset.table LIMIT 10"
jam bq tables my_dataset
```

### Docker Plugin

```json
{
  "name": "docker",
  "version": "1.0.0",
  "description": "Docker container management",
  "commands": ["containers"]
}
```

```javascript
import { execSync } from 'node:child_process';

export function register(program) {
  program
    .command('containers')
    .description('List running Docker containers')
    .option('--json', 'output as JSON')
    .action((opts) => {
      const out = execSync('docker ps --format json', { encoding: 'utf-8' });
      if (opts.json) {
        process.stdout.write(out);
      } else {
        const containers = out.trim().split('\n').filter(Boolean).map(JSON.parse);
        for (const c of containers) {
          console.log(`  ${c.Names.padEnd(30)} ${c.Image.padEnd(40)} ${c.Status}`);
        }
      }
    });
}
```

## Notes

- Plugins execute arbitrary code — only install plugins you trust
- If a plugin registers a command that conflicts with a built-in command, the built-in takes precedence
- Plugin loading is non-fatal: if one plugin fails, others still load
- Plugins use ESM (`export function register`) — CommonJS is not supported
- Plugins can install their own npm dependencies in their directory
