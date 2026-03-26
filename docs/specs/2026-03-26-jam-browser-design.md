# jam browser — AI-Driven Browser Automation

**Date:** 2026-03-26
**Status:** Approved
**Scope:** v1 — thin vertical (launch + record)

---

## Overview

`jam browser` adds browser automation to jam-cli via the Playwright MCP server. Users can control a browser through natural language commands, record interactions into replayable session files, and get AI assistance throughout.

The feature follows jam's existing MCP architecture — no new binary dependencies. The Playwright MCP server handles browser management; jam provides the AI layer, session management, and recording on top.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  jam browser launch / record                │
│  ┌───────────────┐  ┌────────────────────┐  │
│  │ BrowserSession │  │ SessionRecorder    │  │
│  │ (state, AI)    │  │ (actions, traces)  │  │
│  └───────┬───────┘  └────────┬───────────┘  │
│          │                   │              │
│  ┌───────▼───────────────────▼───────────┐  │
│  │ BrowserMcpBridge                      │  │
│  │ (wraps MCP manager, Playwright tools) │  │
│  └───────────────┬───────────────────────┘  │
└──────────────────┼──────────────────────────┘
                   │ MCP stdio
         ┌─────────▼──────────┐
         │ Playwright MCP     │
         │ Server (external)  │
         └────────────────────┘
```

### New Modules

- **`src/browser/bridge.ts`** — Manages the Playwright MCP server connection, wraps MCP tool calls into a clean browser API
- **`src/browser/session.ts`** — Manages browser session state, integrates with AI for natural language command interpretation
- **`src/browser/recorder.ts`** — Records actions and results into the jam-native session format
- **`src/commands/browser.ts`** — CLI command definitions for `jam browser launch` and `jam browser record`

---

## Commands

### `jam browser launch`

Interactive AI-driven browser session.

```bash
jam browser launch                            # opens browser, starts REPL
jam browser launch "go to github.com"         # opens browser with initial task
jam browser launch --url https://example.com  # opens browser at specific URL
```

**Flow:**
1. Starts the Playwright MCP server (or connects to existing one from `.jamrc`)
2. Opens a browser via `browser_navigate`
3. Drops into a REPL (same pattern as `jam go`)
4. For each user command:
   - Takes a snapshot of current page state (`browser_snapshot`)
   - Sends snapshot + user instruction to the AI model
   - AI decides which Playwright MCP tools to call
   - Executes tool calls, shows results
   - Loops until task is done

**REPL slash commands:**
- `/screenshot` — take and save a screenshot
- `/snapshot` — print current page accessibility snapshot
- `/url` — show current URL
- `/tabs` — list open tabs
- `/back` — go back
- `/status` — show session info
- `/exit` — close browser and exit

### `jam browser record`

Same as `launch` but records every action.

```bash
jam browser record                           # record session, save on exit
jam browser record --output my-flow.json     # specify output file
jam browser record --url https://app.com     # start recording at URL
```

**Additional REPL commands during recording:**
- `/note <text>` — annotate the last step with a human note
- `/pause` — pause recording
- `/resume` — resume recording
- `/steps` — show recorded steps so far
- `/save` — save session without exiting

---

## MCP Bridge

`src/browser/bridge.ts` wraps the existing MCP infrastructure (`src/mcp/manager.ts`) to provide a browser-specific API.

**Key decisions:**
- Reuses `src/mcp/manager.ts` — no new MCP transport code
- Creates a dedicated MCP manager instance scoped to the Playwright server only
- Auto-starts the Playwright MCP server if not already configured in `.jamrc` (default command: `npx @anthropic-ai/mcp-playwright`)
- Strips `playwright__` prefix from MCP tool names when presenting to the AI (model sees `browser_click`, bridge re-adds prefix when routing back)

**Bridge API (internal):**
```typescript
interface BrowserBridge {
  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;

  // Convenience wrappers
  navigate(url: string): Promise<string>;
  click(selector: string): Promise<string>;
  fill(selector: string, value: string): Promise<string>;
  snapshot(): Promise<string>;
  screenshot(): Promise<Buffer>;
  evaluate(script: string): Promise<string>;

  // Raw passthrough for AI-driven calls
  executeTool(name: string, args: Record<string, unknown>): Promise<string>;

  // Tool schemas for AI model
  getToolSchemas(): McpToolSchema[];
}
```

**Available Playwright MCP tools:**
`browser_navigate`, `browser_click`, `browser_fill_form`, `browser_type`, `browser_press_key`, `browser_select_option`, `browser_hover`, `browser_drag`, `browser_snapshot`, `browser_take_screenshot`, `browser_tabs`, `browser_navigate_back`, `browser_wait_for`, `browser_evaluate`, `browser_console_messages`, `browser_network_requests`

The AI sees page snapshots (accessibility tree) rather than raw HTML, keeping context window usage manageable.

---

## Session Format

Sessions are saved to `.jam/sessions/` in the workspace by default.

**Jam-native session format (`.jam-session.json`):**
```json
{
  "version": 1,
  "metadata": {
    "name": "login-flow",
    "createdAt": "2026-03-26T10:00:00Z",
    "startUrl": "https://app.com",
    "steps": 12,
    "duration": "45s"
  },
  "steps": [
    {
      "index": 0,
      "action": "browser_navigate",
      "args": { "url": "https://app.com/login" },
      "timestamp": "2026-03-26T10:00:01Z",
      "url": "https://app.com/login",
      "note": "Navigate to login page"
    },
    {
      "index": 1,
      "action": "browser_fill_form",
      "args": { "selector": "#email", "value": "user@example.com" },
      "timestamp": "2026-03-26T10:00:03Z",
      "url": "https://app.com/login",
      "note": "Fill email field"
    }
  ]
}
```

---

## jam doctor Integration

Playwright MCP check is **informational only** — not a blocker. If the Playwright MCP server is not available, doctor shows:

```
  Playwright MCP ... not found (needed for `jam browser` commands)
```

If available:
```
  Playwright MCP ... ok
```

---

## Explicitly Deferred (NOT in v1)

- `jam browser replay` — replay a `.jam-session.json` file
- `jam browser export` — convert `.jam-session.json` to Playwright `.spec.ts`
- Session capture mode — rich recording with network logs, console output, DOM snapshots
- Headless mode — non-interactive browser commands (CI use)
- Direct Playwright library fallback — if MCP isn't available
- Screenshot-on-every-step — opt-in, not default
- Multiple browser support — v1 is Chromium only (MCP server default)

---

## v1 Deliverables

1. `src/browser/bridge.ts` — MCP bridge
2. `src/browser/session.ts` — AI-driven interactive session with REPL
3. `src/browser/recorder.ts` — action recording to `.jam-session.json`
4. `src/commands/browser.ts` — `jam browser launch` + `jam browser record`
5. `jam doctor` — optional Playwright MCP check (informational only)
6. Tests for bridge, session, recorder
