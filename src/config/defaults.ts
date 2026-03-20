import type { JamConfig } from './schema.js';

export const CONFIG_DEFAULTS: JamConfig = {
  defaultProfile: 'default',
  profiles: {
    default: {
      provider: 'ollama',
      model: 'llama3.2',
      baseUrl: 'http://localhost:11434',
    },
  },
  toolPolicy: 'ask_every_time',
  toolAllowlist: [],
  historyEnabled: true,
  logLevel: 'warn',
  redactPatterns: [],
  cacheEnabled: true,
  cacheTtlSeconds: 3600,
  copilotAutoInstall: true,
  intel: {
    enrichDepth: 'deep',
    maxTokenBudget: 500000,
    storageDir: '.jam/intel',
    autoScan: false,
    excludePatterns: ['node_modules', 'dist', '.git', 'vendor', '__pycache__', '.venv', 'target', 'build'],
    diagramFormat: 'mermaid',
    openBrowserOnScan: true,
  },
  agent: {
    maxWorkers: 3,
    defaultMode: 'supervised',
    maxRoundsPerWorker: 20,
    permissions: { safe: [], dangerous: [] },
    sandbox: { filesystem: 'workspace-only', network: 'allowed', timeout: 60000 },
  },
};
