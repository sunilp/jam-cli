import { ResponseCache } from '../storage/response-cache.js';
import { loadConfig } from '../config/loader.js';
import { printError, printSuccess } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import type { CliOverrides } from '../config/schema.js';

// ── jam cache clear ──────────────────────────────────────────────────────────

export async function runCacheClear(options: CliOverrides): Promise<void> {
  try {
    const config = await loadConfig(process.cwd(), options);
    const cache = new ResponseCache(config.cacheTtlSeconds * 1000);
    const removed = await cache.clear();
    await printSuccess(`Cleared ${removed} cached response${removed !== 1 ? 's' : ''}.`);
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}

// ── jam cache stats ──────────────────────────────────────────────────────────

export interface CacheStatsOptions extends CliOverrides {
  json?: boolean;
}

export async function runCacheStats(options: CacheStatsOptions): Promise<void> {
  try {
    const config = await loadConfig(process.cwd(), options);
    const cache = new ResponseCache(config.cacheTtlSeconds * 1000);
    const stats = await cache.stats();

    if (options.json) {
      process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
      return;
    }

    const chalk = (await import('chalk')).default;

    const sizeKB = (stats.sizeBytes / 1024).toFixed(1);
    const ttlMins = Math.round(config.cacheTtlSeconds / 60);

    process.stdout.write('\n');
    process.stdout.write(chalk.bold('  Response Cache\n'));
    process.stdout.write(chalk.dim('  ' + '─'.repeat(40) + '\n'));
    process.stdout.write('\n');
    process.stdout.write(`  Entries:  ${chalk.cyan(String(stats.entries))}\n`);
    process.stdout.write(`  Size:     ${chalk.cyan(sizeKB + ' KB')}\n`);
    process.stdout.write(`  TTL:      ${chalk.cyan(ttlMins + ' min')}\n`);
    process.stdout.write(`  Enabled:  ${config.cacheEnabled ? chalk.green('yes') : chalk.red('no')}\n`);

    if (stats.entries > 0) {
      const oldest = new Date(stats.oldestMs).toLocaleString();
      const newest = new Date(stats.newestMs).toLocaleString();
      process.stdout.write(`  Oldest:   ${chalk.dim(oldest)}\n`);
      process.stdout.write(`  Newest:   ${chalk.dim(newest)}\n`);
    }

    process.stdout.write('\n');
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}

// ── jam cache prune ──────────────────────────────────────────────────────────

export async function runCachePrune(options: CliOverrides): Promise<void> {
  try {
    const config = await loadConfig(process.cwd(), options);
    const cache = new ResponseCache(config.cacheTtlSeconds * 1000);
    const pruned = await cache.prune();
    await printSuccess(`Pruned ${pruned} expired entr${pruned !== 1 ? 'ies' : 'y'}.`);
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}
