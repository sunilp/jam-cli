import { readFileSync } from 'node:fs';

export interface FetchOptions {
  tlsCaPath?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Check whether a hostname should bypass the proxy based on NO_PROXY / no_proxy.
 *
 * NO_PROXY is a comma-separated list of entries. Each entry can be:
 *   - A hostname (e.g. "localhost")
 *   - A domain suffix starting with "." (e.g. ".company.com")
 *   - A bare domain that also matches as a suffix (e.g. "company.com" matches "sub.company.com")
 *   - "*" to bypass all hosts
 */
function isNoProxy(hostname: string): boolean {
  const noProxy = process.env['NO_PROXY'] ?? process.env['no_proxy'];
  if (!noProxy) return false;

  const entries = noProxy.split(',').map((e) => e.trim().toLowerCase());
  const host = hostname.toLowerCase();

  for (const entry of entries) {
    if (!entry) continue;
    if (entry === '*') return true;
    if (host === entry) return true;
    // ".company.com" matches "sub.company.com"
    if (entry.startsWith('.') && host.endsWith(entry)) return true;
    // "company.com" also matches "sub.company.com"
    if (!entry.startsWith('.') && host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * Detect proxy URL from environment variables.
 * Checks HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy in that order.
 */
function getProxyUrl(): string | undefined {
  return (
    process.env['HTTPS_PROXY'] ??
    process.env['HTTP_PROXY'] ??
    process.env['https_proxy'] ??
    process.env['http_proxy'] ??
    undefined
  );
}

/**
 * Proxy-aware fetch wrapper.
 *
 * - Respects HTTPS_PROXY / HTTP_PROXY / https_proxy / http_proxy env vars
 * - Respects NO_PROXY / no_proxy for bypass rules
 * - Supports custom CA certificates via a PEM file path
 * - Supports configurable timeout (defaults to 120 000 ms)
 *
 * When a proxy is detected and the target host is not in NO_PROXY, the request
 * is routed through `undici.ProxyAgent`. Otherwise, the native global `fetch` is used.
 */
export async function proxyFetch(
  url: string | URL,
  init?: RequestInit,
  options?: FetchOptions
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const parsedUrl = new URL(url.toString());
  const proxyUrl = getProxyUrl();

  const shouldProxy = proxyUrl && !isNoProxy(parsedUrl.hostname);

  if (shouldProxy) {
    try {
      // Dynamic import so the module isn't required at top level
      const undici = await import('undici');

      // Build ProxyAgent options
      const connectOptions: Record<string, unknown> = {};
      if (options?.tlsCaPath) {
        connectOptions['ca'] = readFileSync(options.tlsCaPath, 'utf-8');
      }

      const agentOptions = {
        uri: proxyUrl,
        connectTimeout: timeoutMs,
        ...(Object.keys(connectOptions).length > 0 ? { connect: connectOptions } : {}),
      };

      const agent = new undici.ProxyAgent(agentOptions as unknown as string);

      // Build the request init for undici.fetch
      const undiciInit: Record<string, unknown> = { ...init };
      undiciInit['dispatcher'] = agent;
      undiciInit['signal'] = AbortSignal.timeout(timeoutMs);

      const response = await undici.fetch(
        url.toString(),
        undiciInit as Parameters<typeof undici.fetch>[1]
      );

      // Return as a standard Response (undici.Response is compatible)
      return response as unknown as Response;
    } catch (err) {
      // If undici isn't available, fall through to native fetch
      if ((err as NodeJS.ErrnoException)?.code === 'ERR_MODULE_NOT_FOUND' ||
          (err as NodeJS.ErrnoException)?.code === 'MODULE_NOT_FOUND') {
        // Fall through to native fetch below
      } else {
        throw err;
      }
    }
  }

  // No proxy or undici not available — use native fetch with timeout
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}
