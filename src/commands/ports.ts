/**
 * `jam ports` — show what's listening on your dev ports.
 *
 * Parses lsof output on macOS/Linux. Shows PID, process, command, port.
 * Can kill processes by port.
 */

import { execSync } from 'node:child_process';
import chalk from 'chalk';

interface PortEntry {
  port: number;
  pid: number;
  process: string;
  command: string;
  protocol: string;
  state: string;
}

function getListeningPorts(): PortEntry[] {
  const entries: PortEntry[] = [];

  try {
    // macOS / Linux: use lsof
    const raw = execSync('lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null || true', {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const lines = raw.trim().split('\n');
    // Skip header
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i]!.split(/\s+/);
      if (cols.length < 9) continue;

      const process = cols[0]!;
      const pid = parseInt(cols[1]!, 10);
      // The NAME column contains something like *:3000 or 127.0.0.1:8080
      const name = cols[cols.length - 1]!;
      const portMatch = name.match(/:(\d+)$/);
      if (!portMatch) continue;
      const port = parseInt(portMatch[1]!, 10);

      // Get full command line
      let command = process;
      try {
        command = execSync(`ps -p ${pid} -o args= 2>/dev/null || echo "${process}"`, {
          encoding: 'utf-8',
          timeout: 2000,
        }).trim();
        // Truncate long commands
        if (command.length > 80) command = command.slice(0, 77) + '...';
      } catch {
        // Use process name as fallback
      }

      // Avoid duplicates (same port + pid)
      if (!entries.some((e) => e.port === port && e.pid === pid)) {
        entries.push({
          port,
          pid,
          process,
          command,
          protocol: 'TCP',
          state: 'LISTEN',
        });
      }
    }
  } catch {
    // lsof not available, try ss (Linux)
    try {
      const raw = execSync('ss -tlnp 2>/dev/null || true', {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const lines = raw.trim().split('\n');
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i]!.split(/\s+/);
        if (cols.length < 5) continue;
        const local = cols[3]!;
        const portMatch = local.match(/:(\d+)$/);
        if (!portMatch) continue;
        const port = parseInt(portMatch[1]!, 10);
        const procMatch = (cols[5] ?? '').match(/pid=(\d+)/);
        const pid = procMatch ? parseInt(procMatch[1]!, 10) : 0;

        entries.push({
          port,
          pid,
          process: 'unknown',
          command: cols[5] ?? '',
          protocol: 'TCP',
          state: 'LISTEN',
        });
      }
    } catch {
      // Neither lsof nor ss available
    }
  }

  return entries.sort((a, b) => a.port - b.port);
}

/** Well-known dev ports for highlighting */
const KNOWN_PORTS: Record<number, string> = {
  80: 'HTTP', 443: 'HTTPS', 3000: 'React/Express', 3001: 'React alt',
  4000: 'Phoenix', 4200: 'Angular', 5000: 'Flask/Vite', 5173: 'Vite',
  5432: 'PostgreSQL', 5500: 'LiveServer', 6379: 'Redis',
  8000: 'Django/uvicorn', 8080: 'HTTP alt', 8443: 'HTTPS alt',
  8888: 'Jupyter', 9000: 'PHP-FPM', 9090: 'Prometheus',
  9229: 'Node debug', 27017: 'MongoDB', 3306: 'MySQL',
};

export interface PortsOptions {
  kill?: string;
  json?: boolean;
  filter?: string;
}

export function runPorts(options: PortsOptions): void {
  // Kill mode
  if (options.kill) {
    const port = parseInt(options.kill, 10);
    if (isNaN(port)) {
      process.stderr.write(`Invalid port: ${options.kill}\n`);
      process.exit(1);
    }

    const entries = getListeningPorts().filter((e) => e.port === port);
    if (entries.length === 0) {
      process.stderr.write(`Nothing listening on port ${port}.\n`);
      return;
    }

    for (const entry of entries) {
      try {
        process.kill(entry.pid, 'SIGTERM');
        process.stdout.write(
          `Killed ${chalk.bold(entry.process)} (PID ${entry.pid}) on port ${chalk.yellow(String(port))}\n`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Failed to kill PID ${entry.pid}: ${msg}\n`);
      }
    }
    return;
  }

  const entries = getListeningPorts();

  // Filter
  const filtered = options.filter
    ? entries.filter(
        (e) =>
          String(e.port).includes(options.filter!) ||
          e.process.toLowerCase().includes(options.filter!.toLowerCase()) ||
          e.command.toLowerCase().includes(options.filter!.toLowerCase()),
      )
    : entries;

  if (filtered.length === 0) {
    process.stdout.write('No listening ports found.\n');
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(filtered, null, 2) + '\n');
    return;
  }

  // Display
  process.stdout.write(`\n${chalk.bold('Listening Ports')} ${chalk.dim(`(${filtered.length})`)}\n\n`);

  const portW = 7;
  const pidW = 8;
  const procW = 16;

  process.stdout.write(
    `${chalk.dim('PORT'.padEnd(portW))}${chalk.dim('PID'.padEnd(pidW))}${chalk.dim('PROCESS'.padEnd(procW))}${chalk.dim('COMMAND')}\n`,
  );
  process.stdout.write(chalk.dim('─'.repeat(70)) + '\n');

  for (const e of filtered) {
    const known = KNOWN_PORTS[e.port];
    // Pad accounting for chalk codes
    const portDisplay = known
      ? `${chalk.yellow.bold(String(e.port))} ${chalk.dim(known)}`
      : chalk.white(String(e.port));
    const rawPortLen = known ? String(e.port).length + 1 + known.length : String(e.port).length;
    const portPadding = ' '.repeat(Math.max(1, portW + 5 - rawPortLen));

    process.stdout.write(
      `${portDisplay}${portPadding}${chalk.dim(String(e.pid).padEnd(pidW))}${chalk.cyan(e.process.padEnd(procW))}${chalk.dim(e.command)}\n`,
    );
  }

  process.stdout.write(`\n${chalk.dim('Tip: jam ports --kill <port> to stop a process')}\n\n`);
}
