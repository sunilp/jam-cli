/**
 * `jam http` — quick HTTP client with pretty output.
 *
 * Like curl but with auto JSON formatting, timing, colored status codes.
 * Uses Node.js built-in fetch (Node 20+).
 */

import chalk from 'chalk';

function statusColor(status: number): (s: string) => string {
  if (status < 300) return chalk.green;
  if (status < 400) return chalk.yellow;
  if (status < 500) return chalk.hex('#FFA500');
  return chalk.red;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function colorizeJson(json: string): string {
  return json
    .replace(/"([^"]+)":/g, `${chalk.cyan('"$1"')}:`)
    .replace(/: "(.*?)"/g, `: ${chalk.green('"$1"')}`)
    .replace(/: (\d+\.?\d*)/g, `: ${chalk.yellow('$1')}`)
    .replace(/: (true|false)/g, `: ${chalk.magenta('$1')}`)
    .replace(/: (null)/g, `: ${chalk.dim('$1')}`);
}

function parseHeaderFlag(headers: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const h of headers) {
    const idx = h.indexOf(':');
    if (idx === -1) continue;
    result[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  return result;
}

export interface HttpOptions {
  header?: string[];
  body?: string;
  json?: boolean;
  timing?: boolean;
  verbose?: boolean;
  output?: string;
  bearer?: string;
  noColor?: boolean;
}

export async function runHttp(
  method: string | undefined,
  url: string | undefined,
  options: HttpOptions,
): Promise<void> {
  if (!url) {
    // Maybe method was omitted and first arg is URL
    if (method && (method.startsWith('http://') || method.startsWith('https://'))) {
      url = method;
      method = 'GET';
    } else {
      process.stderr.write(`${chalk.bold('Usage')}: jam http <method> <url> [options]\n\n`);
      process.stderr.write(`${chalk.bold('Methods')}: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS\n\n`);
      process.stderr.write(`${chalk.bold('Examples')}:\n`);
      process.stderr.write(`  jam http GET https://api.example.com/users\n`);
      process.stderr.write(`  jam http https://httpbin.org/get\n`);
      process.stderr.write(`  jam http POST https://api.example.com/users --body '{"name":"John"}'\n`);
      process.stderr.write(`  jam http GET https://api.example.com --header "Authorization: Bearer token"\n`);
      process.stderr.write(`  jam http GET https://api.example.com --bearer mytoken123\n`);
      process.stderr.write(`  jam http GET https://api.example.com --timing --verbose\n`);
      return;
    }
  }

  const httpMethod = (method ?? 'GET').toUpperCase();

  // Build headers
  const headers: Record<string, string> = {};
  if (options.header) {
    Object.assign(headers, parseHeaderFlag(options.header));
  }
  if (options.bearer) {
    headers['Authorization'] = `Bearer ${options.bearer}`;
  }

  // Auto-detect JSON body
  let bodyContent: string | undefined;
  if (options.body) {
    bodyContent = options.body;
    // Read from file if body starts with @
    if (bodyContent.startsWith('@')) {
      const { readFileSync } = await import('node:fs');
      try {
        bodyContent = readFileSync(bodyContent.slice(1), 'utf-8');
      } catch {
        process.stderr.write(`Cannot read body file: ${bodyContent.slice(1)}\n`);
        process.exit(1);
        return;
      }
    }
    // Set content-type if not set
    if (!headers['Content-Type'] && !headers['content-type']) {
      try {
        JSON.parse(bodyContent);
        headers['Content-Type'] = 'application/json';
      } catch {
        headers['Content-Type'] = 'text/plain';
      }
    }
  } else if (!process.stdin.isTTY && ['POST', 'PUT', 'PATCH'].includes(httpMethod)) {
    // Read body from stdin (only for methods that accept a body)
    const chunks: Buffer[] = [];
    bodyContent = await new Promise<string>((resolve) => {
      process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    if (!headers['Content-Type'] && !headers['content-type']) {
      try {
        JSON.parse(bodyContent);
        headers['Content-Type'] = 'application/json';
      } catch {
        headers['Content-Type'] = 'text/plain';
      }
    }
  }

  // ── Execute request ────────────────────────────────────────────────────

  const startTime = performance.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: httpMethod,
      headers,
      body: bodyContent,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${chalk.red('Request failed')}: ${msg}\n`);
    process.exit(1);
    return;
  }

  const duration = performance.now() - startTime;

  // ── Display ────────────────────────────────────────────────────────────

  const sColor = statusColor(response.status);

  // Status line
  process.stderr.write(
    `${sColor(`${response.status} ${response.statusText}`)} ${chalk.dim(`${httpMethod} ${url}`)} ${chalk.dim(formatDuration(duration))}\n`,
  );

  // Headers (verbose mode)
  if (options.verbose) {
    process.stderr.write(`\n${chalk.bold.dim('Response Headers')}\n`);
    response.headers.forEach((value, key) => {
      process.stderr.write(`  ${chalk.cyan(key)}: ${chalk.dim(value)}\n`);
    });
    process.stderr.write('\n');
  }

  // Body
  const contentType = response.headers.get('content-type') ?? '';
  const responseText = await response.text();

  if (options.output) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(options.output, responseText);
    process.stderr.write(`Body saved to ${options.output}\n`);
    return;
  }

  if (contentType.includes('json') || options.json) {
    try {
      const parsed: unknown = JSON.parse(responseText);
      const pretty = JSON.stringify(parsed, null, 2);
      process.stdout.write((options.noColor ? pretty : colorizeJson(pretty)) + '\n');
    } catch {
      process.stdout.write(responseText + '\n');
    }
  } else {
    process.stdout.write(responseText);
    // Add newline if response doesn't end with one
    if (!responseText.endsWith('\n')) process.stdout.write('\n');
  }

  // Timing
  if (options.timing) {
    process.stderr.write(`\n${chalk.dim('Timing:')}\n`);
    process.stderr.write(`  ${chalk.dim('Total:')} ${formatDuration(duration)}\n`);
    process.stderr.write(`  ${chalk.dim('Size:')}  ${responseText.length} bytes\n`);
    process.stderr.write('\n');
  }

  // Exit with non-zero for error status codes
  if (response.status >= 400) {
    process.exit(1);
  }
}
