import { BrowserBridge } from './bridge.js';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider, blockIfNoToolSupport } from '../providers/factory.js';
import type { ProviderAdapter, ToolDefinition, Message } from '../providers/base.js';
import type { BrowserCommandOptions } from './types.js';

export type SlashResult = 'handled' | 'exit' | 'unknown';

export class BrowserSession {
  private bridge: BrowserBridge;
  private adapter: ProviderAdapter | null = null;
  private toolSchemas: ToolDefinition[] = [];
  private options: BrowserCommandOptions;
  private currentUrl = '';
  private messages: Message[] = [];

  constructor(options: BrowserCommandOptions) {
    this.options = options;
    this.bridge = new BrowserBridge();
  }

  async start(): Promise<void> {
    await this.bridge.connect();
    this.toolSchemas = this.bridge.getToolSchemas();

    const config = await loadConfig(process.cwd(), {
      profile: this.options.profile,
      provider: this.options.provider,
      model: this.options.model,
      baseUrl: this.options.baseUrl,
    });
    const profile = getActiveProfile(config);
    this.adapter = await createProvider(profile);
    await blockIfNoToolSupport(this.adapter, 'browser');

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
        void rest;
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

    const pageSnapshot = await this.bridge.snapshot();

    this.messages.push({
      role: 'user',
      content: `Current page state:\n${pageSnapshot}\n\nUser instruction: ${input}`,
    });

    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const maxRounds = 10;

    for (let round = 0; round < maxRounds; round++) {
      const response = await this.adapter.chatWithTools(
        this.messages,
        this.toolSchemas,
        {
          systemPrompt:
            "You are a browser automation assistant. You control a web browser using the available tools. Execute the user's instructions by calling the appropriate browser tools. Be precise with selectors. After completing actions, briefly describe what you did.",
          temperature: 0.1,
        },
      );

      if (!response.toolCalls || response.toolCalls.length === 0) {
        this.messages.push({ role: 'assistant', content: response.content ?? '' });
        return { response: response.content ?? '', toolCalls };
      }

      const results: string[] = [];
      for (const tc of response.toolCalls) {
        const result = await this.bridge.executeTool(tc.name, tc.arguments ?? {});
        toolCalls.push({ name: tc.name, args: tc.arguments ?? {} });
        results.push(`[${tc.name}]: ${result}`);

        if (tc.name === 'browser_navigate' && tc.arguments?.url) {
          this.currentUrl = tc.arguments.url as string;
        }
      }

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
