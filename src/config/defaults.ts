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
};
