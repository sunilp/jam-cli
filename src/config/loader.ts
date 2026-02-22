import { cosmiconfig } from 'cosmiconfig';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { JamConfigSchema } from './schema.js';
import { CONFIG_DEFAULTS } from './defaults.js';
import type { JamConfig, CliOverrides, Profile } from './schema.js';
import { JamError } from '../utils/errors.js';

const MODULE_NAME = 'jam';

function deepMergeProfiles(
  base: Record<string, Profile>,
  override: Record<string, Profile>
): Record<string, Profile> {
  const result: Record<string, Profile> = { ...base };
  for (const [key, val] of Object.entries(override)) {
    const existing = result[key];
    if (existing) {
      result[key] = { ...existing, ...val };
    } else {
      result[key] = val;
    }
  }
  return result;
}

function mergeConfigs(base: JamConfig, override: Partial<JamConfig>): JamConfig {
  return {
    ...base,
    ...override,
    profiles: deepMergeProfiles(base.profiles, override.profiles ?? {}),
    toolAllowlist: override.toolAllowlist ?? base.toolAllowlist,
    redactPatterns: override.redactPatterns ?? base.redactPatterns,
  };
}

async function loadFile(searchFrom: string): Promise<Partial<JamConfig>> {
  const explorer = cosmiconfig(MODULE_NAME, {
    searchPlaces: [
      `.${MODULE_NAME}rc`,
      `.${MODULE_NAME}rc.json`,
      `.${MODULE_NAME}rc.yaml`,
      `.${MODULE_NAME}rc.yml`,
      `.${MODULE_NAME}/config.json`,
      `${MODULE_NAME}.config.js`,
      `${MODULE_NAME}.config.cjs`,
    ],
    stopDir: searchFrom,
  });

  const result = await explorer.search(searchFrom);
  if (!result) return {};

  const parsed = JamConfigSchema.partial().safeParse(result.config);
  if (!parsed.success) {
    throw new JamError(
      `Invalid config at ${result.filepath}: ${parsed.error.message}`,
      'CONFIG_INVALID'
    );
  }
  return parsed.data;
}

async function loadUserConfig(): Promise<Partial<JamConfig>> {
  const userConfigDir = join(homedir(), '.config', MODULE_NAME);
  const explorer = cosmiconfig(MODULE_NAME, {
    searchPlaces: ['config.json', 'config.yaml', 'config.yml'],
    stopDir: userConfigDir,
  });

  const result = await explorer.search(userConfigDir);
  if (!result) return {};

  const parsed = JamConfigSchema.partial().safeParse(result.config);
  if (!parsed.success) {
    throw new JamError(
      `Invalid user config at ${result.filepath}: ${parsed.error.message}`,
      'CONFIG_INVALID'
    );
  }
  return parsed.data;
}

export async function loadConfig(
  cwd: string = process.cwd(),
  cliOverrides: CliOverrides = {}
): Promise<JamConfig> {
  const userConfig = await loadUserConfig();
  const repoConfig = await loadFile(cwd);

  let config = mergeConfigs(CONFIG_DEFAULTS, userConfig);
  config = mergeConfigs(config, repoConfig);

  // Apply CLI overrides to the active profile
  const profileName = cliOverrides.profile ?? config.defaultProfile;
  if (cliOverrides.provider || cliOverrides.model || cliOverrides.baseUrl) {
    const existingProfile = config.profiles[profileName] ?? { provider: 'ollama' };
    const overriddenProfile: Profile = {
      ...existingProfile,
      provider: cliOverrides.provider ?? existingProfile.provider,
      ...(cliOverrides.model ? { model: cliOverrides.model } : {}),
      ...(cliOverrides.baseUrl ? { baseUrl: cliOverrides.baseUrl } : {}),
    };
    config = {
      ...config,
      defaultProfile: profileName,
      profiles: {
        ...config.profiles,
        [profileName]: overriddenProfile,
      },
    };
  } else if (cliOverrides.profile) {
    config = { ...config, defaultProfile: profileName };
  }

  return config;
}

export function getActiveProfile(config: JamConfig): Profile {
  const profile = config.profiles[config.defaultProfile];
  if (!profile) {
    throw new JamError(
      `Profile "${config.defaultProfile}" not found in config`,
      'CONFIG_NOT_FOUND'
    );
  }
  return profile;
}
