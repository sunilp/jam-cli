import { createInterface } from 'node:readline/promises';
import { writeFile, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { printError, printSuccess } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot, isGitRepo } from '../utils/workspace.js';
import { generateContextContent, writeContextFile, contextFileExists, CONTEXT_FILENAME } from '../utils/context.js';

interface DetectedProvider {
  name: string;
  label: string;
  reason: string;
  available: boolean;
}

async function isOllamaRunning(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function detectProviders(): Promise<DetectedProvider[]> {
  const providers: DetectedProvider[] = [];

  const ollamaRunning = await isOllamaRunning();
  providers.push({
    name: 'ollama',
    label: 'Ollama (local, private)',
    reason: ollamaRunning ? 'running at localhost:11434' : 'not running — start with: ollama serve',
    available: ollamaRunning,
  });

  const hasAnthropicKey = !!process.env['ANTHROPIC_API_KEY'];
  providers.push({
    name: 'anthropic',
    label: 'Anthropic (Claude)',
    reason: hasAnthropicKey ? 'ANTHROPIC_API_KEY set' : 'set ANTHROPIC_API_KEY to enable',
    available: hasAnthropicKey,
  });

  const hasOpenAIKey = !!process.env['OPENAI_API_KEY'];
  providers.push({
    name: 'openai',
    label: 'OpenAI (GPT)',
    reason: hasOpenAIKey ? 'OPENAI_API_KEY set' : 'set OPENAI_API_KEY to enable',
    available: hasOpenAIKey,
  });

  const hasGroqKey = !!process.env['GROQ_API_KEY'];
  providers.push({
    name: 'groq',
    label: 'Groq (fast inference)',
    reason: hasGroqKey ? 'GROQ_API_KEY set' : 'set GROQ_API_KEY to enable',
    available: hasGroqKey,
  });

  return providers;
}

const DEFAULT_MODELS: Record<string, string> = {
  ollama: 'llama3.2',
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o-mini',
  groq: 'llama3-8b-8192',
};

export interface InitOptions {
  yes?: boolean;
}

export async function runInit(options: InitOptions = {}): Promise<void> {
  const chalk = (await import('chalk')).default;
  const write = (msg: string) => process.stderr.write(msg);

  try {
    write('\n');
    write(chalk.bold('  Welcome to Jam.\n'));
    write('\n');
    write('  Let me figure out what you\'ve got...\n');
    write('\n');

    // Check workspace
    const workspaceRoot = await getWorkspaceRoot();
    const gitRepo = await isGitRepo(workspaceRoot);

    write(`  Project: ${chalk.cyan(workspaceRoot)}${gitRepo ? '' : chalk.yellow(' (not a git repo)')}\n`);
    write('\n');

    // Detect providers
    write('  Scanning for providers...\n');
    write('\n');

    const providers = await detectProviders();
    const available = providers.filter((p) => p.available);

    for (let i = 0; i < providers.length; i++) {
      const p = providers[i]!;
      const icon = p.available ? chalk.green('[✓]') : chalk.dim('[·]');
      const label = p.available ? chalk.white(p.label) : chalk.dim(p.label);
      const num = p.available ? chalk.bold(`${i + 1}`) : chalk.dim(`${i + 1}`);
      write(`  ${num}. ${icon} ${label} ${chalk.dim('— ' + p.reason)}\n`);
    }
    write('\n');

    if (available.length === 0) {
      write(chalk.yellow('  No providers found yet. That\'s fine.\n'));
      write(chalk.dim('  Start Ollama:  ollama serve\n'));
      write(chalk.dim('  Or set a key:  export ANTHROPIC_API_KEY=sk-ant-...\n'));
      write('\n');
    }

    // Select provider
    let selectedProvider: string;
    let selectedModel: string;

    if (options.yes) {
      // Auto-select: first available provider, or ollama as fallback
      selectedProvider = available.length > 0 ? available[0]!.name : 'ollama';
      selectedModel = DEFAULT_MODELS[selectedProvider] ?? 'llama3.2';
      write(`  → Using ${chalk.bold(selectedProvider)} (${selectedModel})\n`);
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stderr });

      const defaultChoice = available.length > 0
        ? String(providers.indexOf(available[0]!) + 1)
        : '1';

      const answer = await rl.question(
        `  Select provider [${defaultChoice}]: `
      );

      const choiceNum = parseInt(answer.trim() || defaultChoice, 10);
      const chosenIdx = choiceNum - 1;

      if (chosenIdx < 0 || chosenIdx >= providers.length) {
        rl.close();
        await printError('Invalid selection.');
        process.exit(1);
      }

      selectedProvider = providers[chosenIdx]!.name;
      selectedModel = DEFAULT_MODELS[selectedProvider] ?? 'llama3.2';

      // Allow model override
      const modelAnswer = await rl.question(
        `  Model [${selectedModel}]: `
      );
      if (modelAnswer.trim()) {
        selectedModel = modelAnswer.trim();
      }

      rl.close();
    }

    write('\n');

    // Write .jamrc
    const configPath = join(workspaceRoot, '.jamrc');
    let configExists = false;
    try {
      await access(configPath, constants.F_OK);
      configExists = true;
    } catch { /* doesn't exist */ }

    const configContent = {
      defaultProfile: 'default',
      profiles: {
        default: {
          provider: selectedProvider,
          model: selectedModel,
          ...(selectedProvider === 'ollama' ? { baseUrl: 'http://localhost:11434' } : {}),
        },
      },
    };

    if (configExists && !options.yes) {
      write(chalk.yellow(`  .jamrc already exists — skipping config.\n`));
    } else {
      await writeFile(configPath, JSON.stringify(configContent, null, 2) + '\n');
      write(`  ${chalk.green('✓')} Created ${chalk.cyan('.jamrc')} with your settings.\n`);
    }

    // Generate JAM.md
    const contextExists = await contextFileExists(workspaceRoot);

    if (contextExists && !options.yes) {
      write(`  ${chalk.yellow('[·]')} ${CONTEXT_FILENAME} already exists — skipping.\n`);
    } else {
      const content = await generateContextContent(workspaceRoot);
      const path = await writeContextFile(workspaceRoot, content);
      write(`  ${chalk.green('✓')} Created ${chalk.cyan(CONTEXT_FILENAME)} for project context.\n`);
    }

    // Quick connectivity check
    write('\n');
    write('  Checking connectivity...\n');
    write('\n');

    try {
      const { createProvider } = await import('../providers/factory.js');
      const adapter = await createProvider({
        provider: selectedProvider,
        model: selectedModel,
        ...(selectedProvider === 'ollama' ? { baseUrl: 'http://localhost:11434' } : {}),
      });
      await adapter.validateCredentials();
      write(`  ${chalk.green('✓')} ${selectedProvider} is reachable\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      write(`  ${chalk.red('✗')} ${selectedProvider} connection failed: ${chalk.dim(msg)}\n`);
      write(chalk.dim('      You can fix this later and run: jam doctor\n'));
    }

    write('\n');
    write(chalk.dim('  ' + '─'.repeat(50) + '\n'));
    write('\n');
    await printSuccess(`  Ready. Try: ${chalk.cyan('jam ask "how does this project work?"')}`);
    write('\n');

  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}
