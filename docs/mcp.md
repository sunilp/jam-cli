# MCP (Model Context Protocol) Support

jam-cli includes built-in support for the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), allowing you to extend your AI workflows with external tool servers. MCP servers are standalone processes that expose tools over a standardized JSON-RPC protocol. jam-cli connects to these servers via stdio transport, discovers their tools, and makes them available within `jam ask`, `jam chat`, and `jam run`.

This document covers configuration, governance, group-based activation, tool filtering, the `jam mcp list` command, and integration with jam's core commands.

---

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Server Options Reference](#server-options-reference)
- [Tool Naming Convention](#tool-naming-convention)
- [Tool Policy](#tool-policy)
- [Tool Filtering: allowedTools and deniedTools](#tool-filtering-allowedtools-and-deniedtools)
- [Group-Based Activation](#group-based-activation)
- [The jam mcp list Command](#the-jam-mcp-list-command)
- [Integration with jam Commands](#integration-with-jam-commands)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)

---

## Overview

MCP support in jam-cli provides:

- **Extensibility** -- connect to any MCP-compatible server to add tools (filesystem access, database queries, browser automation, Jira, Slack, and more).
- **Governance** -- control which servers are active, which tools are exposed, and whether tool execution requires confirmation.
- **Group-based activation** -- organize servers into groups and activate only the groups you need for a given context.
- **Per-server policy** -- set tool approval policies independently for each server.
- **Fine-grained filtering** -- allowlist or denylist specific tools on each server.

jam-cli implements the MCP stdio transport natively (no external SDK dependency). It spawns each server as a child process and communicates via newline-delimited JSON-RPC over stdin/stdout.

---

## How It Works

1. When you run `jam ask`, `jam chat`, or `jam run`, jam reads MCP server declarations from your `.jamrc` configuration.
2. It filters servers by `enabled` status and active `mcpGroups`.
3. For each qualifying server, jam spawns the process, performs the MCP `initialize` handshake, and discovers available tools via `tools/list`.
4. Discovered tools are merged with jam's built-in tools and sent to the AI model as available functions.
5. When the model calls an MCP tool, jam routes the call to the appropriate server, enforces the tool policy, and returns the result.
6. On exit, jam gracefully shuts down all MCP server connections.

---

## Configuration

MCP servers are declared in your `.jamrc` file (JSON, YAML, or JavaScript -- any format cosmiconfig supports). The two top-level keys are `mcpServers` and `mcpGroups`.

### Minimal Configuration

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
    }
  }
}
```

This declares a single MCP server named `filesystem` that will be started with `npx` and the given arguments. Since no `enabled`, `group`, or `toolPolicy` is specified, it defaults to enabled with the `auto` policy and no group restriction.

### Full Configuration

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"],
      "env": {},
      "enabled": true,
      "group": "code",
      "toolPolicy": "auto",
      "allowedTools": ["read_file", "list_directory", "search_files"],
      "deniedTools": []
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "POSTGRES_URL": "postgresql://localhost:5432/mydb"
      },
      "enabled": true,
      "group": "db",
      "toolPolicy": "ask",
      "deniedTools": ["execute_sql"]
    },
    "browser": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-puppeteer"],
      "enabled": true,
      "group": "browser",
      "toolPolicy": "ask"
    },
    "legacy-server": {
      "command": "node",
      "args": ["./tools/legacy-server.js"],
      "enabled": false
    }
  },
  "mcpGroups": ["code", "db"]
}
```

---

## Server Options Reference

Each entry under `mcpServers` is keyed by a server name (used in tool naming and display) and accepts the following options:

| Option          | Type       | Default  | Description                                                                 |
|-----------------|------------|----------|-----------------------------------------------------------------------------|
| `command`       | `string`   | required | The command to start the MCP server (e.g. `"npx"`, `"node"`, `"python"`).  |
| `args`          | `string[]` | `[]`     | Arguments passed to the command.                                            |
| `env`           | `object`   | `{}`     | Extra environment variables set for the server process.                     |
| `enabled`       | `boolean`  | `true`   | Whether this server is active. Set to `false` to skip without removing it.  |
| `group`         | `string`   | none     | Group tag (e.g. `"code"`, `"jira"`, `"db"`, `"browser"`, or any custom).   |
| `toolPolicy`    | `string`   | `"auto"` | Tool approval policy: `"auto"`, `"ask"`, or `"deny"`.                      |
| `allowedTools`  | `string[]` | none     | If set, only these tools are exposed from this server (allowlist).          |
| `deniedTools`   | `string[]` | none     | If set, these tools are hidden from this server (denylist).                 |

---

## Tool Naming Convention

When MCP tools are registered with the AI model, they are prefixed with the server name to avoid collisions with jam's built-in tools:

```
mcp__{serverName}__{toolName}
```

For example, a tool called `read_file` from a server named `filesystem` becomes:

```
mcp__filesystem__read_file
```

A tool called `query` from a server named `postgres` becomes:

```
mcp__postgres__query
```

This namespacing is automatic. You do not need to use the prefixed names in `allowedTools` or `deniedTools` -- those lists use the original tool names as reported by the MCP server.

---

## Tool Policy

Each MCP server has a `toolPolicy` that controls how its tools are executed:

| Policy   | Behavior                                                                                          |
|----------|---------------------------------------------------------------------------------------------------|
| `auto`   | Follows the global `toolPolicy` setting from your `.jamrc`. This is the default.                  |
| `ask`    | Always prompts for user confirmation before executing any tool from this server.                   |
| `deny`   | Blocks all tool execution. Tools from this server are hidden from the model entirely.             |

### Example: Mixed policies

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "toolPolicy": "auto"
    },
    "database": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "POSTGRES_URL": "postgresql://localhost:5432/prod" },
      "toolPolicy": "ask"
    },
    "untrusted-server": {
      "command": "node",
      "args": ["./experimental/server.js"],
      "toolPolicy": "deny"
    }
  }
}
```

In this configuration:
- `filesystem` tools execute according to your global policy.
- `database` tools always prompt for confirmation, regardless of the global policy.
- `untrusted-server` tools are completely blocked -- the model will not see them.

---

## Tool Filtering: allowedTools and deniedTools

You can control exactly which tools from a server are exposed to the model using `allowedTools` and `deniedTools`. Both use the original tool names as reported by the MCP server (not the `mcp__` prefixed names).

### allowedTools (whitelist)

When `allowedTools` is set and non-empty, only the listed tools are exposed. All other tools from that server are hidden.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "allowedTools": ["read_file", "list_directory", "search_files"]
    }
  }
}
```

This exposes only `read_file`, `list_directory`, and `search_files`. Other tools like `write_file` or `create_directory` are hidden.

### deniedTools (blacklist)

When `deniedTools` is set, the listed tools are hidden. All other tools remain available.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "deniedTools": ["write_file", "create_directory", "move_file"]
    }
  }
}
```

This hides destructive tools while keeping read-oriented tools available.

### Combining allowedTools and deniedTools

Both can be specified together. When combined, `deniedTools` takes precedence. A tool must pass both filters to be exposed:

1. If `allowedTools` is set, the tool must be in the list.
2. If `deniedTools` is set, the tool must NOT be in the list.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "allowedTools": ["read_file", "list_directory", "search_files", "get_file_info"],
      "deniedTools": ["get_file_info"]
    }
  }
}
```

Here, `get_file_info` is in both lists -- `deniedTools` wins, so only `read_file`, `list_directory`, and `search_files` are exposed.

---

## Group-Based Activation

Groups let you organize MCP servers by function and selectively activate them. This is useful when you have many servers configured but only need a subset for your current task.

### Assigning groups

Each server can have an optional `group` tag:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "group": "code"
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxxxx" },
      "group": "code"
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "POSTGRES_URL": "postgresql://localhost:5432/mydb" },
      "group": "db"
    },
    "jira": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-jira"],
      "env": { "JIRA_URL": "https://team.atlassian.net", "JIRA_TOKEN": "xxx" },
      "group": "jira"
    },
    "puppeteer": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-puppeteer"],
      "group": "browser"
    }
  }
}
```

### Activating groups with mcpGroups

The `mcpGroups` array at the top level of your config determines which groups are active:

```json
{
  "mcpGroups": ["code", "db"],
  "mcpServers": {
    "...": "..."
  }
}
```

**Behavior:**

- When `mcpGroups` is set and non-empty, only servers whose `group` matches one of the active groups will be connected. Servers with no group or a non-matching group are skipped.
- When `mcpGroups` is omitted or empty, all enabled servers are connected regardless of their group.

### Examples of group filtering

Given the five servers above:

| `mcpGroups` value       | Connected servers                                |
|-------------------------|--------------------------------------------------|
| `["code"]`              | `filesystem`, `github`                           |
| `["code", "db"]`        | `filesystem`, `github`, `postgres`               |
| `["jira"]`              | `jira`                                           |
| `["code", "browser"]`   | `filesystem`, `github`, `puppeteer`              |
| `[]` or omitted         | All five servers (all enabled servers connect)    |

### Servers without a group

A server with no `group` set will only connect when `mcpGroups` is omitted or empty. When `mcpGroups` is specified, groupless servers are skipped.

```json
{
  "mcpServers": {
    "misc-tools": {
      "command": "node",
      "args": ["./tools/misc.js"]
    }
  },
  "mcpGroups": ["code"]
}
```

In this case, `misc-tools` has no group and `mcpGroups` is set, so it will be skipped.

---

## The jam mcp list Command

Use `jam mcp list` to inspect which MCP servers are configured, which are connected, and what tools they expose.

### Basic usage

```bash
jam mcp list
```

Output:

```
MCP: connected to "filesystem" (filesystem-server) -- 5 tools
MCP: connected to "postgres" (postgres-server) -- 3 tools
MCP: skipping "jira" (group "jira" not in active groups)
MCP: skipping "legacy-server" (disabled)

Active Groups: code, db

Skipped: jira (group filtered), legacy-server (disabled)

Connected MCP Servers

filesystem (filesystem-server) [code] policy:auto
  > read_file -- Read the contents of a file
  > list_directory -- List directory contents
  > search_files -- Search for files matching a pattern
  > write_file -- Write content to a file
  > get_file_info -- Get file metadata

postgres (postgres-server) [db] policy:ask (3/4 tools exposed)
  > query -- Execute a read-only SQL query
  > list_tables -- List database tables
  > describe_table -- Get table schema
```

### JSON output

```bash
jam mcp list --json
```

Outputs structured JSON with `connected` and `skipped` arrays:

```json
{
  "connected": [
    {
      "name": "filesystem",
      "serverInfo": "filesystem-server",
      "group": "code",
      "toolPolicy": "auto",
      "totalTools": 5,
      "filteredTools": 5,
      "tools": [
        { "name": "read_file", "description": "Read the contents of a file" },
        { "name": "list_directory", "description": "List directory contents" }
      ]
    }
  ],
  "skipped": [
    { "name": "jira", "reason": "group \"jira\" not active" },
    { "name": "legacy-server", "reason": "disabled" }
  ]
}
```

The JSON output is useful for scripting and automation. Use it to verify your configuration programmatically:

```bash
jam mcp list --json | jq '.connected | length'
```

---

## Integration with jam Commands

MCP tools are available in three jam commands, each with a different scope and behavior.

### jam ask

In `jam ask`, MCP tools are merged with jam's built-in **read-only** tool set. The model can call MCP tools to gather context before generating a response.

```bash
jam ask "What tables exist in the database and what does the users schema look like?"
```

If a `postgres` MCP server is configured, the model can call `mcp__postgres__list_tables` and `mcp__postgres__describe_table` to answer the question.

Policy enforcement applies: tools from servers with `toolPolicy: "ask"` will prompt for confirmation. Tools from servers with `toolPolicy: "deny"` are not exposed.

### jam chat

In `jam chat`, MCP tools are available throughout the interactive REPL session. The MCP manager is created when the chat session starts and shut down when it ends.

```bash
jam chat
```

```
> What files are in the src directory?
[MCP: filesystem] Calling list_directory...
The src directory contains: index.ts, config/, commands/, ...

> Read the main entry point
[MCP: filesystem] Calling read_file...
Here's the content of src/index.ts: ...
```

### jam run

In `jam run`, MCP tools are merged with jam's full tool set (including write-capable tools). The agentic tool-calling loop can use MCP tools alongside built-in tools like `apply_patch` and `write_file`.

```bash
jam run "Create a migration to add an email column to the users table"
```

The model might:
1. Call `mcp__postgres__describe_table` to inspect the current schema.
2. Use built-in `write_file` to create the migration file.
3. Call `mcp__postgres__query` to verify the syntax.

Policy enforcement is applied at each tool call. The `ask` policy is particularly important in `jam run` since the agentic loop may execute many tools autonomously.

---

## Examples

### Example 1: Read-only filesystem access

Expose only read operations from the filesystem server:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"],
      "group": "code",
      "toolPolicy": "auto",
      "allowedTools": ["read_file", "list_directory", "search_files"]
    }
  }
}
```

### Example 2: Database with confirmation prompts

Connect to a production database but require confirmation for every query:

```json
{
  "mcpServers": {
    "prod-db": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "POSTGRES_URL": "postgresql://readonly@prod-db:5432/myapp"
      },
      "group": "db",
      "toolPolicy": "ask",
      "deniedTools": ["execute_sql"]
    }
  }
}
```

### Example 3: Multiple servers with group-based activation

Configure several servers but only activate code-related ones:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "group": "code"
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_xxxxx" },
      "group": "code"
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "POSTGRES_URL": "postgresql://localhost/mydb" },
      "group": "db"
    },
    "slack": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-slack"],
      "env": { "SLACK_TOKEN": "xoxb-xxxxx" },
      "group": "comms"
    }
  },
  "mcpGroups": ["code"]
}
```

Only `filesystem` and `github` connect. To also use the database, change to:

```json
{
  "mcpGroups": ["code", "db"]
}
```

### Example 4: Denying an untrusted server

Keep a server configured but block all tool execution:

```json
{
  "mcpServers": {
    "experimental": {
      "command": "node",
      "args": ["./tools/experimental-server.js"],
      "toolPolicy": "deny"
    }
  }
}
```

The server still connects (so you can inspect its tools with `jam mcp list`), but its tools are hidden from the model and cannot be executed.

### Example 5: Temporarily disabling a server

Use `enabled: false` to skip a server without removing its configuration:

```json
{
  "mcpServers": {
    "jira": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-jira"],
      "env": { "JIRA_URL": "https://team.atlassian.net" },
      "enabled": false,
      "group": "jira"
    }
  }
}
```

The server is completely skipped -- no process is spawned, no connection is made.

### Example 6: Custom environment variables

Pass secrets and configuration to a server process:

```json
{
  "mcpServers": {
    "my-api": {
      "command": "node",
      "args": ["./servers/api-bridge.js"],
      "env": {
        "API_KEY": "sk-xxxxx",
        "API_BASE_URL": "https://api.example.com",
        "LOG_LEVEL": "debug"
      },
      "group": "api",
      "toolPolicy": "ask"
    }
  }
}
```

The `env` values are merged with the current process environment. They do not replace existing variables -- they extend them.

### Example 7: Scripting with jam mcp list --json

Check that a specific server is connected:

```bash
# Count connected servers
jam mcp list --json | jq '.connected | length'

# List tool names from a specific server
jam mcp list --json | jq '.connected[] | select(.name == "filesystem") | .tools[].name'

# Check if any servers were skipped
jam mcp list --json | jq '.skipped'
```

### Example 8: Using MCP tools in jam ask

Ask a question that requires data from an MCP server:

```bash
jam ask "List all tables in the database and show the schema for the users table"
```

With a `postgres` server configured, the model will call `mcp__postgres__list_tables` and `mcp__postgres__describe_table` to answer the question, then present the results in a readable format.

### Example 9: Browser automation with policy guard

Configure a browser MCP server with confirmation prompts:

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-puppeteer"],
      "group": "browser",
      "toolPolicy": "ask",
      "deniedTools": ["screenshot"]
    }
  },
  "mcpGroups": ["code", "browser"]
}
```

The browser server connects, but every tool call requires confirmation. The `screenshot` tool is blocked entirely.

### Example 10: Multiple databases with different policies

```json
{
  "mcpServers": {
    "dev-db": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "POSTGRES_URL": "postgresql://localhost/devdb" },
      "group": "db",
      "toolPolicy": "auto"
    },
    "staging-db": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "POSTGRES_URL": "postgresql://staging-host/stagingdb" },
      "group": "db",
      "toolPolicy": "ask"
    },
    "prod-db": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": { "POSTGRES_URL": "postgresql://prod-host/proddb" },
      "group": "db",
      "toolPolicy": "deny"
    }
  },
  "mcpGroups": ["db"]
}
```

All three servers are in the `db` group and all connect. But:
- `dev-db` tools execute freely (following the global policy).
- `staging-db` tools always prompt for confirmation.
- `prod-db` tools are completely blocked.

### Example 11: YAML configuration

If you prefer YAML, create a `.jamrc.yml`:

```yaml
mcpServers:
  filesystem:
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-filesystem"
      - /home/user/projects
    group: code
    toolPolicy: auto
    allowedTools:
      - read_file
      - list_directory
      - search_files

  postgres:
    command: npx
    args:
      - -y
      - "@modelcontextprotocol/server-postgres"
    env:
      POSTGRES_URL: postgresql://localhost:5432/mydb
    group: db
    toolPolicy: ask

mcpGroups:
  - code
  - db
```

### Example 12: Combining MCP tools with built-in tools in jam run

```bash
jam run "Find all TODO comments in the codebase using the filesystem server, then create a summary report"
```

The agentic loop might:
1. Call `mcp__filesystem__search_files` to find files with TODOs.
2. Call `mcp__filesystem__read_file` to read each matching file.
3. Use the built-in `write_file` tool to create `TODO-report.md`.

MCP tools and built-in tools work side by side in the same tool-calling loop.

---

## Troubleshooting

### Server fails to connect

If a server fails to connect, jam logs the error and continues with the remaining servers. Check:

- The `command` is installed and available on your PATH.
- The `args` are correct for the server.
- Any required `env` variables are set.
- The server supports the MCP protocol version `2024-11-05`.

Run `jam mcp list` to see which servers connected and which were skipped.

### Tools not appearing

If tools from a server are not visible to the model:

1. Check `toolPolicy` -- if set to `"deny"`, all tools are hidden.
2. Check `allowedTools` -- if set, only listed tools are exposed.
3. Check `deniedTools` -- listed tools are hidden.
4. Check `mcpGroups` -- if set, the server's `group` must match.
5. Check `enabled` -- if `false`, the server is skipped entirely.

### Server timeout

MCP requests have a 30-second timeout. If a server takes longer to respond, the request will fail with a timeout error. This is not configurable at the moment.

### Debugging connection issues

Run `jam mcp list` to see connection status. For more detail, set `logLevel` to `"debug"` in your `.jamrc`:

```json
{
  "logLevel": "debug"
}
```

This will print MCP handshake details and tool discovery results to stderr.
