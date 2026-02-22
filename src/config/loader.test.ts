import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { loadConfig, getActiveProfile } from './loader.js';
import { CONFIG_DEFAULTS } from './defaults.js';
import type { JamConfig } from './schema.js';

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'jam-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
  });

  it('returns defaults when no config files exist', async () => {
    const config = await loadConfig(tmpDir);
    expect(config.defaultProfile).toBe('default');
    expect(config.toolPolicy).toBe('ask_every_time');
    expect(config.historyEnabled).toBe(true);
  });

  it('merges repo config over defaults', async () => {
    const repoConfig = {
      defaultProfile: 'custom',
      profiles: {
        custom: {
          provider: 'ollama',
          model: 'mistral',
          baseUrl: 'http://localhost:11434',
        },
      },
    };
    writeFileSync(join(tmpDir, '.jamrc'), JSON.stringify(repoConfig));

    const config = await loadConfig(tmpDir);
    expect(config.defaultProfile).toBe('custom');
    expect(config.profiles['custom']?.model).toBe('mistral');
  });

  it('deep merges profiles — repo overrides individual keys, preserves others', async () => {
    const repoConfig = {
      profiles: {
        default: {
          model: 'codellama',
        },
      },
    };
    writeFileSync(join(tmpDir, '.jamrc'), JSON.stringify(repoConfig));

    const config = await loadConfig(tmpDir);
    // model should be overridden
    expect(config.profiles['default']?.model).toBe('codellama');
    // provider from defaults should be preserved
    expect(config.profiles['default']?.provider).toBe('ollama');
  });

  it('applies CLI overrides to active profile', async () => {
    const config = await loadConfig(tmpDir, { model: 'gemma2', provider: 'ollama' });
    expect(config.profiles['default']?.model).toBe('gemma2');
  });

  it('applies CLI profile override', async () => {
    const repoConfig = {
      profiles: {
        work: { provider: 'ollama', model: 'llama3.2' },
      },
    };
    writeFileSync(join(tmpDir, '.jamrc'), JSON.stringify(repoConfig));

    const config = await loadConfig(tmpDir, { profile: 'work' });
    expect(config.defaultProfile).toBe('work');
  });

  it('throws CONFIG_INVALID for malformed config', async () => {
    writeFileSync(join(tmpDir, '.jamrc'), JSON.stringify({ toolPolicy: 'invalid_value' }));
    await expect(loadConfig(tmpDir)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});

describe('getActiveProfile', () => {
  it('returns the active profile', () => {
    const config: JamConfig = {
      ...CONFIG_DEFAULTS,
      defaultProfile: 'default',
      profiles: {
        default: { provider: 'ollama', model: 'llama3.2', baseUrl: 'http://localhost:11434' },
      },
    };
    const profile = getActiveProfile(config);
    expect(profile.model).toBe('llama3.2');
  });

  it('throws CONFIG_NOT_FOUND when profile missing', () => {
    const config: JamConfig = {
      ...CONFIG_DEFAULTS,
      defaultProfile: 'missing',
      profiles: {},
    };
    let thrown: unknown;
    try {
      getActiveProfile(config);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ code: 'CONFIG_NOT_FOUND' });
  });
});
