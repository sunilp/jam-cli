# jam browser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AI-driven browser automation to jam via `jam browser launch` and `jam browser record`, powered by the Playwright MCP server.

**Architecture:** A `BrowserBridge` wraps the existing MCP manager to communicate with the Playwright MCP server. A `BrowserSession` runs a REPL (modeled on `jam go`) that sends natural language commands to the AI, which translates them into Playwright tool calls. A `SessionRecorder` intercepts tool calls and saves them to `.jam-session.json` files.

**Tech Stack:** TypeScript, vitest, existing MCP infrastructure (`src/mcp/manager.ts`, `src/mcp/client.ts`), Commander.js

**Spec:** `docs/specs/2026-03-26-jam-browser-design.md`

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/browser/bridge.ts` | Manages Playwright MCP server lifecycle; wraps MCP tool calls into typed browser API; strips/re-adds MCP name prefixes |
| `src/browser/bridge.test.ts` | Tests for bridge: connection, tool name mapping, tool execution routing |
| `src/browser/session.ts` | Interactive REPL with AI integration; sends page snapshots + user input to model; executes returned tool calls |
| `src/browser/session.test.ts` | Tests for session: slash commands, AI tool call routing, snapshot-before-action flow |
| `src/browser/recorder.ts` | Records each tool call as a step in the jam-native session format; saves to `.jam-session.json` |
| `src/browser/recorder.test.ts` | Tests for recorder: step capture, pause/resume, save/load |
| `src/browser/types.ts` | Shared types: `SessionStep`, `SessionFile`, `BrowserBridgeOptions` |
| `src/commands/browser.ts` | Commander definitions for `jam browser launch` and `jam browser record` |
| `src/commands/doctor.ts` | Modified: add optional Playwright MCP check (informational only) |
| `src/index.ts` | Modified: register `jam browser` command group |

---

## Task 1: Shared Types

**Files:**
- Create: `src/browser/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/browser/types.ts

export interface BrowserBridgeOptions {
  /** MCP server command override (default: npx @anthropic-ai/mcp-playwright) */
  command?: string;
  /** MCP server args override */
  args?: string[];
  /** Log function for MCP status messages */
  log?: (msg: string) => void;
}

export interface SessionStep {
  index: number;
  action: string;
  args: Record<string, unknown>;
  timestamp: string;
  url: string;
  note?: string;
}

export interface SessionFile {
  version: 1;
  metadata: SessionMetadata;
  steps: SessionStep[];
}

export interface SessionMetadata {
  name: string;
  createdAt: string;
  startUrl: string;
  steps: number;
  duration: string;
}

/** Options for jam browser launch / record commands */
export interface BrowserCommandOptions {
  profile?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  url?: string;
  output?: string;
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit src/browser/types.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/browser/types.ts
git commit -m "feat(browser): add shared types for browser automation"
```

---

## Task 2: Browser MCP Bridge

**Files:**
- Create: `src/browser/bridge.ts`
- Create: `src/browser/bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/browser/bridge.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../mcp/manager.js', () => ({
  McpManager: vi.fn().mockImplementation(() => ({
    connectAll: vi.fn(),
    getToolSchemas: vi.fn().mockReturnValue([]),
    executeTool: vi.fn().mockResolvedValue('ok'),
    isOwnTool: vi.fn().mockReturnValue(true),
    shutdown: vi.fn(),
  })),
}));

import { BrowserBridge } from './bridge.js';
import { McpManager } from '../mcp/manager.js';

describe('BrowserBridge', () => {
  let bridge: BrowserBridge;
  let mockManager: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockManager = vi.mocked(McpManager).mock.results[0]?.value;
    bridge = new BrowserBridge();
  });

  afterEach(async () => {
    try { await bridge.disconnect(); } catch { /* ignore */ }
  });

  describe('connect', () => {
    it('should start the Playwright MCP server with default command', async () => {
      await bridge.connect();
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      expect(managerInstance.connectAll).toHaveBeenCalledWith(
        expect.objectContaining({
          playwright: expect.objectContaining({
            command: 'npx',
            args: expect.arrayContaining(['@anthropic-ai/mcp-playwright']),
          }),
        }),
        expect.any(Function),
        undefined,
      );
    });

    it('should accept custom command override', async () => {
      bridge = new BrowserBridge({ command: 'my-playwright', args: ['--headless'] });
      await bridge.connect();
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      expect(managerInstance.connectAll).toHaveBeenCalledWith(
        expect.objectContaining({
          playwright: expect.objectContaining({
            command: 'my-playwright',
            args: ['--headless'],
          }),
        }),
        expect.any(Function),
        undefined,
      );
    });
  });

  describe('getToolSchemas', () => {
    it('should strip mcp__playwright__ prefix from tool names', async () => {
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      managerInstance.getToolSchemas.mockReturnValue([
        { name: 'mcp__playwright__browser_click', description: 'Click', readonly: false, parameters: { type: 'object', properties: {}, required: [] } },
        { name: 'mcp__playwright__browser_navigate', description: 'Navigate', readonly: false, parameters: { type: 'object', properties: {}, required: [] } },
      ]);

      await bridge.connect();
      const schemas = bridge.getToolSchemas();

      expect(schemas[0].name).toBe('browser_click');
      expect(schemas[1].name).toBe('browser_navigate');
    });
  });

  describe('executeTool', () => {
    it('should re-add mcp__playwright__ prefix when calling MCP manager', async () => {
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      managerInstance.getToolSchemas.mockReturnValue([]);
      await bridge.connect();

      await bridge.executeTool('browser_click', { selector: '#btn' });

      expect(managerInstance.executeTool).toHaveBeenCalledWith(
        'mcp__playwright__browser_click',
        { selector: '#btn' },
      );
    });
  });

  describe('convenience methods', () => {
    it('navigate should call browser_navigate', async () => {
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      managerInstance.getToolSchemas.mockReturnValue([]);
      await bridge.connect();

      await bridge.navigate('https://example.com');

      expect(managerInstance.executeTool).toHaveBeenCalledWith(
        'mcp__playwright__browser_navigate',
        { url: 'https://example.com' },
      );
    });

    it('snapshot should call browser_snapshot', async () => {
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      managerInstance.getToolSchemas.mockReturnValue([]);
      await bridge.connect();

      await bridge.snapshot();

      expect(managerInstance.executeTool).toHaveBeenCalledWith(
        'mcp__playwright__browser_snapshot',
        {},
      );
    });

    it('click should call browser_click', async () => {
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      managerInstance.getToolSchemas.mockReturnValue([]);
      await bridge.connect();

      await bridge.click('button[type="submit"]');

      expect(managerInstance.executeTool).toHaveBeenCalledWith(
        'mcp__playwright__browser_click',
        { element: 'button[type="submit"]' },
      );
    });

    it('fill should call browser_fill_form', async () => {
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      managerInstance.getToolSchemas.mockReturnValue([]);
      await bridge.connect();

      await bridge.fill('#email', 'user@example.com');

      expect(managerInstance.executeTool).toHaveBeenCalledWith(
        'mcp__playwright__browser_fill_form',
        { selector: '#email', value: 'user@example.com' },
      );
    });
  });

  describe('disconnect', () => {
    it('should shut down the MCP manager', async () => {
      const managerInstance = vi.mocked(McpManager).mock.results[0].value;
      managerInstance.getToolSchemas.mockReturnValue([]);
      await bridge.connect();

      await bridge.disconnect();

      expect(managerInstance.shutdown).toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/browser/bridge.test.ts`
Expected: FAIL — `./bridge.js` module not found

- [ ] **Step 3: Implement the bridge**

```typescript
// src/browser/bridge.ts
import { McpManager } from '../mcp/manager.js';
import type { McpToolSchema } from '../mcp/types.js';
import type { BrowserBridgeOptions } from './types.js';

const MCP_SERVER_NAME = 'playwright';
const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const DEFAULT_COMMAND = 'npx';
const DEFAULT_ARGS = ['@anthropic-ai/mcp-playwright'];

export class BrowserBridge {
  private manager: McpManager;
  private options: BrowserBridgeOptions;
  private connected = false;

  constructor(options: BrowserBridgeOptions = {}) {
    this.options = options;
    this.manager = new McpManager();
  }

  async connect(): Promise<void> {
    const log = this.options.log ?? (() => {});
    await this.manager.connectAll(
      {
        [MCP_SERVER_NAME]: {
          command: this.options.command ?? DEFAULT_COMMAND,
          args: this.options.args ?? DEFAULT_ARGS,
        },
      },
      log,
      undefined,
    );
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.manager.shutdown();
      this.connected = false;
    }
  }

  /** Get tool schemas with mcp__playwright__ prefix stripped */
  getToolSchemas(): McpToolSchema[] {
    return this.manager.getToolSchemas().map((schema) => ({
      ...schema,
      name: schema.name.startsWith(MCP_PREFIX)
        ? schema.name.slice(MCP_PREFIX.length)
        : schema.name,
    }));
  }

  /** Execute a tool, re-adding the MCP prefix */
  async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const qualifiedName = name.startsWith(MCP_PREFIX) ? name : `${MCP_PREFIX}${name}`;
    return this.manager.executeTool(qualifiedName, args);
  }

  // ── Convenience wrappers ──────────────────────────────────────────────

  async navigate(url: string): Promise<string> {
    return this.executeTool('browser_navigate', { url });
  }

  async click(selector: string): Promise<string> {
    return this.executeTool('browser_click', { element: selector });
  }

  async fill(selector: string, value: string): Promise<string> {
    return this.executeTool('browser_fill_form', { selector, value });
  }

  async type(text: string): Promise<string> {
    return this.executeTool('browser_type', { text });
  }

  async pressKey(key: string): Promise<string> {
    return this.executeTool('browser_press_key', { key });
  }

  async snapshot(): Promise<string> {
    return this.executeTool('browser_snapshot', {});
  }

  async screenshot(): Promise<string> {
    return this.executeTool('browser_take_screenshot', {});
  }

  async evaluate(script: string): Promise<string> {
    return this.executeTool('browser_evaluate', { script });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/browser/bridge.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/browser/bridge.ts src/browser/bridge.test.ts
git commit -m "feat(browser): add MCP bridge for Playwright server"
```

---

## Task 3: Session Recorder

**Files:**
- Create: `src/browser/recorder.ts`
- Create: `src/browser/recorder.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/browser/recorder.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRecorder } from './recorder.js';
import type { SessionStep } from './types.js';

describe('SessionRecorder', () => {
  let recorder: SessionRecorder;

  beforeEach(() => {
    recorder = new SessionRecorder({ name: 'test-session', startUrl: 'https://example.com' });
  });

  describe('record', () => {
    it('should record a step with auto-incrementing index', () => {
      recorder.record('browser_navigate', { url: 'https://example.com' }, 'https://example.com');
      recorder.record('browser_click', { element: '#btn' }, 'https://example.com');

      const steps = recorder.getSteps();
      expect(steps).toHaveLength(2);
      expect(steps[0].index).toBe(0);
      expect(steps[0].action).toBe('browser_navigate');
      expect(steps[1].index).toBe(1);
      expect(steps[1].action).toBe('browser_click');
    });

    it('should include a timestamp on each step', () => {
      recorder.record('browser_navigate', { url: 'https://example.com' }, 'https://example.com');

      const steps = recorder.getSteps();
      expect(steps[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('pause/resume', () => {
    it('should not record steps while paused', () => {
      recorder.record('browser_navigate', { url: 'https://a.com' }, 'https://a.com');
      recorder.pause();
      recorder.record('browser_click', { element: '#x' }, 'https://a.com');
      recorder.resume();
      recorder.record('browser_click', { element: '#y' }, 'https://a.com');

      const steps = recorder.getSteps();
      expect(steps).toHaveLength(2);
      expect(steps[0].action).toBe('browser_navigate');
      expect(steps[1].action).toBe('browser_click');
      expect(steps[1].args).toEqual({ element: '#y' });
    });
  });

  describe('annotate', () => {
    it('should add a note to the last step', () => {
      recorder.record('browser_click', { element: '#btn' }, 'https://example.com');
      recorder.annotate('Clicked the submit button');

      const steps = recorder.getSteps();
      expect(steps[0].note).toBe('Clicked the submit button');
    });

    it('should do nothing if no steps exist', () => {
      expect(() => recorder.annotate('note')).not.toThrow();
    });
  });

  describe('toSessionFile', () => {
    it('should produce a valid SessionFile', () => {
      recorder.record('browser_navigate', { url: 'https://example.com' }, 'https://example.com');

      const file = recorder.toSessionFile();

      expect(file.version).toBe(1);
      expect(file.metadata.name).toBe('test-session');
      expect(file.metadata.startUrl).toBe('https://example.com');
      expect(file.metadata.steps).toBe(1);
      expect(file.steps).toHaveLength(1);
    });

    it('should compute duration from first to last step', () => {
      // Use fake timers to control timestamps
      vi.useFakeTimers();
      const now = new Date('2026-03-26T10:00:00Z');
      vi.setSystemTime(now);

      recorder.record('browser_navigate', { url: 'https://a.com' }, 'https://a.com');

      vi.setSystemTime(new Date('2026-03-26T10:00:45Z'));
      recorder.record('browser_click', { element: '#x' }, 'https://a.com');

      const file = recorder.toSessionFile();
      expect(file.metadata.duration).toBe('45s');

      vi.useRealTimers();
    });
  });

  describe('isPaused', () => {
    it('should reflect pause state', () => {
      expect(recorder.isPaused()).toBe(false);
      recorder.pause();
      expect(recorder.isPaused()).toBe(true);
      recorder.resume();
      expect(recorder.isPaused()).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/browser/recorder.test.ts`
Expected: FAIL — `./recorder.js` module not found

- [ ] **Step 3: Implement the recorder**

```typescript
// src/browser/recorder.ts
import type { SessionStep, SessionFile, SessionMetadata } from './types.js';

export interface RecorderOptions {
  name: string;
  startUrl: string;
}

export class SessionRecorder {
  private steps: SessionStep[] = [];
  private paused = false;
  private name: string;
  private startUrl: string;
  private createdAt: string;

  constructor(options: RecorderOptions) {
    this.name = options.name;
    this.startUrl = options.startUrl;
    this.createdAt = new Date().toISOString();
  }

  record(action: string, args: Record<string, unknown>, url: string): void {
    if (this.paused) return;
    this.steps.push({
      index: this.steps.length,
      action,
      args,
      timestamp: new Date().toISOString(),
      url,
    });
  }

  annotate(note: string): void {
    const last = this.steps[this.steps.length - 1];
    if (last) last.note = note;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  isPaused(): boolean {
    return this.paused;
  }

  getSteps(): readonly SessionStep[] {
    return this.steps;
  }

  toSessionFile(): SessionFile {
    const duration = this.computeDuration();
    const metadata: SessionMetadata = {
      name: this.name,
      createdAt: this.createdAt,
      startUrl: this.startUrl,
      steps: this.steps.length,
      duration,
    };
    return { version: 1, metadata, steps: [...this.steps] };
  }

  private computeDuration(): string {
    if (this.steps.length < 2) return '0s';
    const first = new Date(this.steps[0].timestamp).getTime();
    const last = new Date(this.steps[this.steps.length - 1].timestamp).getTime();
    const seconds = Math.round((last - first) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/browser/recorder.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/browser/recorder.ts src/browser/recorder.test.ts
git commit -m "feat(browser): add session recorder with pause/resume and annotation"
```

---

## Task 4: Browser Session (REPL + AI)

**Files:**
- Create: `src/browser/session.ts`
- Create: `src/browser/session.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/browser/session.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./bridge.js', () => ({
  BrowserBridge: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue('Navigated'),
    snapshot: vi.fn().mockResolvedValue('Page snapshot: button "Submit"'),
    screenshot: vi.fn().mockResolvedValue('Screenshot saved'),
    getToolSchemas: vi.fn().mockReturnValue([
      { name: 'browser_navigate', description: 'Navigate', inputSchema: { type: 'object', properties: {}, required: [] } },
      { name: 'browser_click', description: 'Click', inputSchema: { type: 'object', properties: {}, required: [] } },
    ]),
    executeTool: vi.fn().mockResolvedValue('ok'),
  })),
}));

vi.mock('../config/loader.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({ mcpServers: {} }),
  getActiveProfile: vi.fn().mockReturnValue({ provider: 'ollama', model: 'llama3.2' }),
}));

vi.mock('../providers/factory.js', () => ({
  createProvider: vi.fn().mockResolvedValue({
    info: { name: 'ollama', supportsStreaming: true, supportsTools: true },
    chatWithTools: vi.fn(),
  }),
  blockIfNoToolSupport: vi.fn(),
}));

import { BrowserSession } from './session.js';
import { BrowserBridge } from './bridge.js';

describe('BrowserSession', () => {
  let session: BrowserSession;
  let mockBridge: {
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    navigate: ReturnType<typeof vi.fn>;
    snapshot: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    getToolSchemas: ReturnType<typeof vi.fn>;
    executeTool: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    session = new BrowserSession({});
    mockBridge = vi.mocked(BrowserBridge).mock.results[0]?.value;
  });

  describe('start', () => {
    it('should connect to the Playwright MCP bridge', async () => {
      await session.start();
      expect(mockBridge.connect).toHaveBeenCalled();
    });

    it('should navigate to initial URL if provided', async () => {
      session = new BrowserSession({ url: 'https://example.com' });
      mockBridge = vi.mocked(BrowserBridge).mock.results[1]?.value;

      await session.start();
      expect(mockBridge.navigate).toHaveBeenCalledWith('https://example.com');
    });
  });

  describe('handleSlashCommand', () => {
    it('should handle /screenshot', async () => {
      await session.start();
      const result = await session.handleSlashCommand('/screenshot');
      expect(result).toBe('handled');
      expect(mockBridge.screenshot).toHaveBeenCalled();
    });

    it('should handle /snapshot', async () => {
      await session.start();
      const result = await session.handleSlashCommand('/snapshot');
      expect(result).toBe('handled');
      expect(mockBridge.snapshot).toHaveBeenCalled();
    });

    it('should handle /back', async () => {
      await session.start();
      const result = await session.handleSlashCommand('/back');
      expect(result).toBe('handled');
      expect(mockBridge.executeTool).toHaveBeenCalledWith('browser_navigate_back', {});
    });

    it('should handle /tabs', async () => {
      await session.start();
      const result = await session.handleSlashCommand('/tabs');
      expect(result).toBe('handled');
      expect(mockBridge.executeTool).toHaveBeenCalledWith('browser_tabs', {});
    });

    it('should return "exit" for /exit', async () => {
      await session.start();
      const result = await session.handleSlashCommand('/exit');
      expect(result).toBe('exit');
    });

    it('should return "unknown" for unrecognized commands', async () => {
      await session.start();
      const result = await session.handleSlashCommand('/foo');
      expect(result).toBe('unknown');
    });
  });

  describe('stop', () => {
    it('should disconnect the bridge', async () => {
      await session.start();
      await session.stop();
      expect(mockBridge.disconnect).toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/browser/session.test.ts`
Expected: FAIL — `./session.js` module not found

- [ ] **Step 3: Implement the session**

```typescript
// src/browser/session.ts
import { BrowserBridge } from './bridge.js';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider, blockIfNoToolSupport } from '../providers/factory.js';
import type { ProviderAdapter } from '../providers/base.js';
import type { McpToolSchema } from '../mcp/types.js';
import type { BrowserCommandOptions } from './types.js';

export type SlashResult = 'handled' | 'exit' | 'unknown';

export class BrowserSession {
  private bridge: BrowserBridge;
  private adapter: ProviderAdapter | null = null;
  private toolSchemas: McpToolSchema[] = [];
  private options: BrowserCommandOptions;
  private currentUrl = '';
  private messages: Array<{ role: string; content: string }> = [];

  constructor(options: BrowserCommandOptions) {
    this.options = options;
    this.bridge = new BrowserBridge();
  }

  async start(): Promise<void> {
    // Connect bridge
    await this.bridge.connect();
    this.toolSchemas = this.bridge.getToolSchemas();

    // Set up AI provider
    const config = await loadConfig(process.cwd(), {
      profile: this.options.profile,
      provider: this.options.provider,
      model: this.options.model,
      baseUrl: this.options.baseUrl,
    });
    const profile = getActiveProfile(config);
    this.adapter = await createProvider(profile);
    await blockIfNoToolSupport(this.adapter, 'browser');

    // Navigate to initial URL if provided
    if (this.options.url) {
      await this.bridge.navigate(this.options.url);
      this.currentUrl = this.options.url;
    }
  }

  async handleSlashCommand(input: string): Promise<SlashResult> {
    const [cmd, ...rest] = input.split(' ');
    switch (cmd) {
      case '/exit':
      case '/quit':
        return 'exit';
      case '/screenshot':
        await this.bridge.screenshot();
        return 'handled';
      case '/snapshot': {
        const snap = await this.bridge.snapshot();
        process.stderr.write(snap + '\n');
        return 'handled';
      }
      case '/url':
        process.stderr.write((this.currentUrl || '(no page loaded)') + '\n');
        return 'handled';
      case '/tabs': {
        const tabs = await this.bridge.executeTool('browser_tabs', {});
        process.stderr.write(tabs + '\n');
        return 'handled';
      }
      case '/back':
        await this.bridge.executeTool('browser_navigate_back', {});
        return 'handled';
      case '/status':
        process.stderr.write(`URL: ${this.currentUrl || '(none)'}\n`);
        process.stderr.write(`Tools: ${this.toolSchemas.length}\n`);
        return 'handled';
      case '/help':
        process.stderr.write('Commands:\n');
        process.stderr.write('  /screenshot  — save a screenshot\n');
        process.stderr.write('  /snapshot    — print page accessibility tree\n');
        process.stderr.write('  /url         — show current URL\n');
        process.stderr.write('  /tabs        — list open tabs\n');
        process.stderr.write('  /back        — go back\n');
        process.stderr.write('  /status      — session info\n');
        process.stderr.write('  /exit        — close browser\n\n');
        process.stderr.write('Everything else is sent to the AI.\n');
        return 'handled';
      default:
        return 'unknown';
    }
  }

  /**
   * Process a natural language command:
   * 1. Take a snapshot of current page
   * 2. Send snapshot + user instruction to AI
   * 3. Execute returned tool calls
   * 4. Return final text response
   */
  async processCommand(input: string): Promise<{
    response: string;
    toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  }> {
    if (!this.adapter?.chatWithTools) {
      return { response: 'AI provider does not support tool calling.', toolCalls: [] };
    }

    // Get current page state
    const pageSnapshot = await this.bridge.snapshot();

    // Build messages
    this.messages.push({
      role: 'user',
      content: `Current page state:\n${pageSnapshot}\n\nUser instruction: ${input}`,
    });

    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const maxRounds = 10;

    for (let round = 0; round < maxRounds; round++) {
      const response = await this.adapter.chatWithTools(
        this.messages as Array<{ role: 'user' | 'assistant'; content: string }>,
        this.toolSchemas as Array<{
          name: string;
          description: string;
          readonly: boolean;
          parameters: { type: 'object'; properties: Record<string, unknown>; required: string[] };
        }>,
        {
          systemPrompt: 'You are a browser automation assistant. You control a web browser using the available tools. Execute the user\'s instructions by calling the appropriate browser tools. Be precise with selectors. After completing actions, briefly describe what you did.',
          temperature: 0.1,
        },
      );

      if (!response.toolCalls || response.toolCalls.length === 0) {
        this.messages.push({ role: 'assistant', content: response.content ?? '' });
        return { response: response.content ?? '', toolCalls };
      }

      // Execute each tool call
      const results: string[] = [];
      for (const tc of response.toolCalls) {
        const result = await this.bridge.executeTool(tc.name, tc.arguments ?? {});
        toolCalls.push({ name: tc.name, args: tc.arguments ?? {} });
        results.push(`[${tc.name}]: ${result}`);

        // Track URL changes
        if (tc.name === 'browser_navigate' && tc.arguments?.url) {
          this.currentUrl = tc.arguments.url as string;
        }
      }

      // Feed results back to AI
      this.messages.push({
        role: 'assistant',
        content: response.content ?? '',
      });
      this.messages.push({
        role: 'user',
        content: `Tool results:\n${results.join('\n')}`,
      });
    }

    return { response: 'Reached maximum rounds.', toolCalls };
  }

  getCurrentUrl(): string {
    return this.currentUrl;
  }

  getBridge(): BrowserBridge {
    return this.bridge;
  }

  async stop(): Promise<void> {
    await this.bridge.disconnect();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/browser/session.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/browser/session.ts src/browser/session.test.ts
git commit -m "feat(browser): add interactive session with AI-driven tool calling"
```

---

## Task 5: Command Registration (`jam browser launch` + `jam browser record`)

**Files:**
- Create: `src/commands/browser.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create the command file**

```typescript
// src/commands/browser.ts
import * as readline from 'node:readline';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserSession } from '../browser/session.js';
import { SessionRecorder } from '../browser/recorder.js';
import { renderMarkdown, printError } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import type { BrowserCommandOptions } from '../browser/types.js';

export async function runBrowserLaunch(options: BrowserCommandOptions, initialPrompt?: string): Promise<void> {
  const session = new BrowserSession(options);

  try {
    process.stderr.write('\njam browser\n');
    process.stderr.write('Starting Playwright MCP bridge...\n');
    await session.start();
    process.stderr.write('Browser ready. Type a command, or /help.\n\n');

    if (initialPrompt) {
      const result = await session.processCommand(initialPrompt);
      await renderMarkdown(result.response);
    }

    await runRepl(session, null);
  } catch (err) {
    printError(JamError.fromUnknown(err));
  } finally {
    await session.stop();
  }
}

export async function runBrowserRecord(options: BrowserCommandOptions): Promise<void> {
  const session = new BrowserSession(options);
  const recorder = new SessionRecorder({
    name: options.output?.replace(/\.jam-session\.json$/, '') ?? `session-${Date.now()}`,
    startUrl: options.url ?? '',
  });

  try {
    process.stderr.write('\njam browser record\n');
    process.stderr.write('Starting Playwright MCP bridge...\n');
    await session.start();
    process.stderr.write('Recording. Type a command, or /help.\n\n');

    await runRepl(session, recorder);

    // Save session on exit
    const sessionFile = recorder.toSessionFile();
    const outputDir = join(process.cwd(), '.jam', 'sessions');
    mkdirSync(outputDir, { recursive: true });
    const outputPath = options.output
      ? (options.output.endsWith('.json') ? options.output : `${options.output}.jam-session.json`)
      : join(outputDir, `${sessionFile.metadata.name}.jam-session.json`);
    writeFileSync(outputPath, JSON.stringify(sessionFile, null, 2));
    process.stderr.write(`\nSession saved: ${outputPath}\n`);
    process.stderr.write(`${sessionFile.metadata.steps} steps, ${sessionFile.metadata.duration}\n`);
  } catch (err) {
    printError(JamError.fromUnknown(err));
  } finally {
    await session.stop();
  }
}

async function runRepl(session: BrowserSession, recorder: SessionRecorder | null): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: 'browser> ',
  });

  return new Promise<void>((resolve) => {
    rl.prompt();

    rl.on('line', (line) => {
      void (async () => {
        const input = line.trim();
        if (!input) { rl.prompt(); return; }

        // Recorder-specific slash commands
        if (recorder) {
          if (input.startsWith('/note ')) {
            recorder.annotate(input.slice(6));
            process.stderr.write('Note added.\n');
            rl.prompt();
            return;
          }
          if (input === '/pause') {
            recorder.pause();
            process.stderr.write('Recording paused.\n');
            rl.prompt();
            return;
          }
          if (input === '/resume') {
            recorder.resume();
            process.stderr.write('Recording resumed.\n');
            rl.prompt();
            return;
          }
          if (input === '/steps') {
            const steps = recorder.getSteps();
            if (steps.length === 0) {
              process.stderr.write('No steps recorded yet.\n');
            } else {
              for (const step of steps) {
                const note = step.note ? ` — ${step.note}` : '';
                process.stderr.write(`  ${step.index}. ${step.action}${note}\n`);
              }
            }
            rl.prompt();
            return;
          }
          if (input === '/save') {
            const sessionFile = recorder.toSessionFile();
            const outputDir = join(process.cwd(), '.jam', 'sessions');
            mkdirSync(outputDir, { recursive: true });
            const path = join(outputDir, `${sessionFile.metadata.name}.jam-session.json`);
            writeFileSync(path, JSON.stringify(sessionFile, null, 2));
            process.stderr.write(`Saved: ${path}\n`);
            rl.prompt();
            return;
          }
        }

        // Standard slash commands
        if (input.startsWith('/')) {
          const result = await session.handleSlashCommand(input);
          if (result === 'exit') {
            rl.close();
            resolve();
            return;
          }
          if (result === 'unknown') {
            process.stderr.write(`Unknown: ${input}. Try /help.\n`);
          }
          rl.prompt();
          return;
        }

        // Natural language command → AI
        try {
          const result = await session.processCommand(input);
          await renderMarkdown(result.response);

          // Record tool calls if recording
          if (recorder) {
            for (const tc of result.toolCalls) {
              recorder.record(tc.name, tc.args, session.getCurrentUrl());
            }
          }
        } catch (err) {
          printError(JamError.fromUnknown(err));
        }

        rl.prompt();
      })();
    });

    rl.on('close', () => resolve());
  });
}
```

- [ ] **Step 2: Register the command group in `src/index.ts`**

Find the location where other subcommand groups are registered (near `auth`, `config`, `models`). Add the `browser` group. The exact insertion point is after the last command registration and before `program.parse()`.

Add this block to `src/index.ts`:

```typescript
// ── browser ──────────────────────────────────────────────────────────────────
const browserCmd = program
  .command('browser')
  .description('AI-driven browser automation via Playwright');

browserCmd
  .command('launch [prompt]')
  .description('Launch an interactive AI-driven browser session')
  .option('--url <url>', 'open browser at this URL')
  .action(async (prompt: string | undefined, cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runBrowserLaunch } = await import('./commands/browser.js');
    await runBrowserLaunch({
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      url: cmdOpts['url'] as string | undefined,
    }, prompt);
  });

browserCmd
  .command('record')
  .description('Launch browser and record all interactions to a session file')
  .option('--url <url>', 'open browser at this URL')
  .option('--output <path>', 'output file path for the session recording')
  .action(async (cmdOpts: Record<string, unknown>) => {
    const g = globalOpts();
    const { runBrowserRecord } = await import('./commands/browser.js');
    await runBrowserRecord({
      profile: g.profile,
      provider: g.provider,
      model: g.model,
      baseUrl: g.baseUrl,
      url: cmdOpts['url'] as string | undefined,
      output: cmdOpts['output'] as string | undefined,
    });
  });
```

- [ ] **Step 3: Verify the project compiles**

Run: `npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/commands/browser.ts src/index.ts
git commit -m "feat(browser): add jam browser launch and record commands"
```

---

## Task 6: Doctor Integration (Optional Playwright Check)

**Files:**
- Modify: `src/commands/doctor.ts`

- [ ] **Step 1: Read the current doctor.ts to identify exact insertion point**

Read `src/commands/doctor.ts` and locate the array of checks. The Playwright check goes at the end of the check list.

- [ ] **Step 2: Add the Playwright MCP check**

Add this check after the existing checks array (same pattern as the ripgrep or copilot check):

```typescript
// Playwright MCP (informational only — never fails)
check('Playwright MCP', async () => {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(execFile);
    await execAsync('npx', ['@anthropic-ai/mcp-playwright', '--help'], { timeout: 15_000 });
    return { status: 'pass', detail: 'available' };
  } catch {
    return { status: 'warn', detail: 'not found (needed for jam browser commands)' };
  }
}),
```

Key: this uses `status: 'warn'` not `status: 'fail'` — it is informational only and never blocks doctor from passing.

- [ ] **Step 3: Run doctor to verify it works**

Run: `npx tsx src/index.ts doctor`
Expected: Playwright MCP shows as either "ok" or warning — doctor still passes overall

- [ ] **Step 4: Commit**

```bash
git add src/commands/doctor.ts
git commit -m "feat(doctor): add optional Playwright MCP availability check"
```

---

## Task 7: Integration Test

**Files:**
- Create: `src/commands/browser.test.ts`

- [ ] **Step 1: Write integration test for command wiring**

```typescript
// src/commands/browser.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../browser/session.js', () => ({
  BrowserSession: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    processCommand: vi.fn().mockResolvedValue({ response: 'Done', toolCalls: [] }),
    handleSlashCommand: vi.fn().mockResolvedValue('exit'),
    getCurrentUrl: vi.fn().mockReturnValue('https://example.com'),
    getBridge: vi.fn(),
  })),
}));

vi.mock('../browser/recorder.js', () => ({
  SessionRecorder: vi.fn().mockImplementation(() => ({
    record: vi.fn(),
    annotate: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    isPaused: vi.fn().mockReturnValue(false),
    getSteps: vi.fn().mockReturnValue([]),
    toSessionFile: vi.fn().mockReturnValue({
      version: 1,
      metadata: { name: 'test', createdAt: '2026-01-01', startUrl: '', steps: 0, duration: '0s' },
      steps: [],
    }),
  })),
}));

vi.mock('../ui/renderer.js', () => ({
  renderMarkdown: vi.fn(),
  printError: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, writeFileSync: vi.fn(), mkdirSync: vi.fn() };
});

import { BrowserSession } from '../browser/session.js';

describe('browser commands', () => {
  it('should create a BrowserSession with provided options', async () => {
    // Importing the module triggers the mock
    const { runBrowserLaunch } = await import('./browser.js');

    // runBrowserLaunch opens a REPL which reads stdin.
    // Since our mock handleSlashCommand returns 'exit' immediately,
    // we simulate stdin closing to exit the REPL.
    const originalCreateInterface = (await import('node:readline')).createInterface;
    vi.spyOn(await import('node:readline'), 'createInterface').mockReturnValue({
      prompt: vi.fn(),
      on: vi.fn().mockImplementation((event: string, cb: () => void) => {
        if (event === 'close') setTimeout(cb, 0);
        return { prompt: vi.fn(), on: vi.fn() };
      }),
      close: vi.fn(),
    } as unknown as ReturnType<typeof originalCreateInterface>);

    await runBrowserLaunch({ url: 'https://example.com' });

    expect(BrowserSession).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com' }),
    );
  });
});
```

- [ ] **Step 2: Run all browser tests**

Run: `npx vitest run src/browser/ src/commands/browser.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Run the full test suite to check for regressions**

Run: `npx vitest run`
Expected: All existing tests still pass

- [ ] **Step 4: Commit**

```bash
git add src/commands/browser.test.ts
git commit -m "test(browser): add integration test for command wiring"
```

---

## Summary

| Task | What it builds | Estimated steps |
|------|---------------|-----------------|
| 1 | Shared types | 3 |
| 2 | MCP bridge + tests | 5 |
| 3 | Session recorder + tests | 5 |
| 4 | Interactive session + tests | 5 |
| 5 | Command registration | 4 |
| 6 | Doctor integration | 4 |
| 7 | Integration test + full suite | 4 |

**Total: 7 tasks, 30 steps, 7 commits**
