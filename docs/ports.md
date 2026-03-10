# jam ports

Show what is listening on your development ports. Displays PID, process name, full command, port number, and protocol. Highlights well-known development ports (React, PostgreSQL, Redis, etc.) for quick identification. No AI provider required.

## Synopsis

```
jam ports [options]
```

## Options

| Flag | Description |
|------|-------------|
| `--kill <port>` | Send SIGTERM to the process listening on the given port |
| `--filter <term>` | Filter results by port number, process name, or command string |
| `--json` | Output results as JSON |

## How It Works

1. Runs `lsof -iTCP -sTCP:LISTEN -P -n` to discover listening TCP sockets (macOS and Linux).
2. Falls back to `ss -tlnp` on Linux systems where `lsof` is unavailable.
3. For each entry, fetches the full command line via `ps -p <pid> -o args=`.
4. Deduplicates entries by port + PID combination.
5. Sorts output by port number (ascending).
6. Commands longer than 80 characters are truncated.

## Well-Known Dev Ports

The following ports are highlighted with labels when detected:

| Port | Label | Port | Label |
|------|-------|------|-------|
| 80 | HTTP | 5432 | PostgreSQL |
| 443 | HTTPS | 5500 | LiveServer |
| 3000 | React/Express | 6379 | Redis |
| 3001 | React alt | 8000 | Django/uvicorn |
| 3306 | MySQL | 8080 | HTTP alt |
| 4000 | Phoenix | 8443 | HTTPS alt |
| 4200 | Angular | 8888 | Jupyter |
| 5000 | Flask/Vite | 9000 | PHP-FPM |
| 5173 | Vite | 9090 | Prometheus |
| 9229 | Node debug | 27017 | MongoDB |

## Examples

### List all listening ports

```
jam ports
```

Sample output:

```
Listening Ports (5)

PORT         PID     PROCESS         COMMAND
----------------------------------------------------------------------
3000 React/Express   45123   node            node ./node_modules/.bin/react-scripts start
5173 Vite            45200   node            /usr/local/bin/node vite --port 5173
5432 PostgreSQL      1234    postgres        /usr/lib/postgresql/15/bin/postgres -D /var/...
6379 Redis           5678    redis-ser       redis-server *:6379
8080 HTTP alt        9012    java            java -jar target/app.jar --server.port=8080

Tip: jam ports --kill <port> to stop a process
```

### Filter by process name

```
jam ports --filter node
```

Shows only entries where the process name or command string contains "node".

### Filter by port number

```
jam ports --filter 3000
```

Shows only entries on port 3000.

### Kill a process by port

```
jam ports --kill 3000
```

Output:

```
Killed node (PID 45123) on port 3000
```

This sends SIGTERM to the process. If no process is listening on that port, it prints a message and exits cleanly.

### Kill and then verify it is gone

```
jam ports --kill 8080 && jam ports --filter 8080
```

If the kill succeeded, the second command will show "No listening ports found."

### Output as JSON for scripting

```
jam ports --json
```

Returns an array of objects:

```json
[
  {
    "port": 3000,
    "pid": 45123,
    "process": "node",
    "command": "node ./node_modules/.bin/react-scripts start",
    "protocol": "TCP",
    "state": "LISTEN"
  },
  {
    "port": 5432,
    "pid": 1234,
    "process": "postgres",
    "command": "/usr/lib/postgresql/15/bin/postgres -D /var/lib/postgresql/15/main",
    "protocol": "TCP",
    "state": "LISTEN"
  }
]
```

### Find which process is using a specific port from a script

```
jam ports --json | jq '.[] | select(.port == 8080) | .command'
```

### Check if a port is free before starting a server

```
if jam ports --json | jq -e '.[] | select(.port == 3000)' > /dev/null 2>&1; then
  echo "Port 3000 is in use"
  jam ports --kill 3000
fi
npm start
```

## Notes

- The `--kill` flag sends SIGTERM, not SIGKILL. If a process does not respond to SIGTERM, you may need to use `kill -9 <pid>` directly.
- Killing a process may require elevated privileges. If the PID belongs to another user or a system process, the command will print an error message.
- On macOS, `lsof` is used by default. On Linux, `lsof` is tried first, then `ss` as a fallback.
- Only TCP sockets in the LISTEN state are shown. UDP listeners and established connections are not included.
