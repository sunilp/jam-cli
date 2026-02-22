import { logger } from './logger.js';

const SERVICE_NAME = 'jam-cli';

export async function getSecret(key: string): Promise<string | null> {
  // Try keytar first (secure OS keychain)
  try {
    const keytar = await import('keytar');
    const value = await keytar.default.getPassword(SERVICE_NAME, key);
    if (value !== null) return value;
  } catch {
    logger.debug('keytar not available, falling back to environment variables');
  }

  // Fall back to environment variable
  const envKey = `JAM_${key.toUpperCase().replace(/-/g, '_')}`;
  return process.env[envKey] ?? null;
}

export async function setSecret(key: string, value: string): Promise<void> {
  try {
    const keytar = await import('keytar');
    await keytar.default.setPassword(SERVICE_NAME, key, value);
    return;
  } catch {
    logger.warn('keytar not available. Credentials will not be stored securely in keychain.');
    logger.warn(`Set the environment variable JAM_${key.toUpperCase().replace(/-/g, '_')} instead.`);
  }
}

export async function deleteSecret(key: string): Promise<boolean> {
  try {
    const keytar = await import('keytar');
    return keytar.default.deletePassword(SERVICE_NAME, key);
  } catch {
    logger.debug('keytar not available, nothing to delete');
    return false;
  }
}
