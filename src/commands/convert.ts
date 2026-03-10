/**
 * `jam convert` — format converter swiss knife.
 *
 * JSON <-> YAML <-> CSV, Base64, URL encode/decode, Hex.
 * Reads from file or stdin.
 */

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import chalk from 'chalk';

type Format = 'json' | 'yaml' | 'csv' | 'base64' | 'url' | 'hex';

const FORMAT_ALIASES: Record<string, Format> = {
  json: 'json', yml: 'yaml', yaml: 'yaml',
  csv: 'csv', tsv: 'csv',
  base64: 'base64', b64: 'base64',
  url: 'url', urlencode: 'url', percent: 'url',
  hex: 'hex',
};

function detectFormat(input: string, filename?: string): Format | null {
  // By filename extension
  if (filename) {
    const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
    if (ext in FORMAT_ALIASES) return FORMAT_ALIASES[ext]!;
  }

  const trimmed = input.trim();

  // JSON
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { JSON.parse(trimmed); return 'json'; } catch { /* not json */ }
  }

  // Base64 (no spaces, only base64 chars, reasonable length)
  if (/^[A-Za-z0-9+/\n]+=*$/.test(trimmed) && trimmed.length > 10) {
    return 'base64';
  }

  // URL encoded
  if (/%[0-9A-Fa-f]{2}/.test(trimmed)) return 'url';

  // Hex string
  if (/^[0-9a-fA-F\s]+$/.test(trimmed) && trimmed.length > 4) return 'hex';

  // CSV (has commas on multiple lines)
  if (trimmed.includes(',') && trimmed.includes('\n')) return 'csv';

  // YAML (has colons on first line)
  if (trimmed.includes(':')) return 'yaml';

  return null;
}

// ── CSV parser/serializer ────────────────────────────────────────────────────

function parseCsv(input: string): Record<string, string>[] {
  const lines = input.trim().split('\n');
  if (lines.length < 2) return [];

  const parseRow = (row: string): string[] => {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < row.length; i++) {
      const ch = row[i]!;
      if (inQuotes) {
        if (ch === '"' && row[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          cells.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
    }
    cells.push(current);
    return cells;
  };

  const headers = parseRow(lines[0]!);
  return lines.slice(1).filter((l) => l.trim()).map((line) => {
    const values = parseRow(line);
    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]!] = values[i] ?? '';
    }
    return row;
  });
}

function toCsv(data: unknown): string {
  if (!Array.isArray(data)) {
    throw new Error('CSV output requires an array of objects');
  }
  if (data.length === 0) return '';

  const first: unknown = data[0];
  if (typeof first !== 'object' || first === null) {
    throw new Error('CSV output requires an array of objects');
  }

  const headers = Object.keys(first as Record<string, unknown>);
  const escapeCsv = (val: unknown): string => {
    const s = String(val ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const rows = [headers.join(',')];
  for (const item of data) {
    const obj = item as Record<string, unknown>;
    rows.push(headers.map((h) => escapeCsv(obj[h])).join(','));
  }
  return rows.join('\n');
}

// ── stdin reader ─────────────────────────────────────────────────────────────

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

export interface ConvertOptions {
  from?: string;
  to?: string;
}

export async function runConvert(file: string | undefined, options: ConvertOptions): Promise<void> {
  // Read input
  let input: string;
  if (file) {
    try {
      input = readFileSync(file, 'utf-8');
    } catch {
      process.stderr.write(`Cannot read: ${file}\n`);
      process.exit(1);
      return;
    }
  } else if (!process.stdin.isTTY) {
    input = await readStdin();
  } else {
    process.stderr.write(`${chalk.bold('Usage')}: jam convert <file> --to <format>\n\n`);
    process.stderr.write(`${chalk.bold('Formats')}: json, yaml, csv, base64, url, hex\n\n`);
    process.stderr.write(`${chalk.bold('Examples')}:\n`);
    process.stderr.write(`  jam convert data.json --to yaml\n`);
    process.stderr.write(`  jam convert config.yaml --to json\n`);
    process.stderr.write(`  jam convert data.csv --to json\n`);
    process.stderr.write(`  echo "hello world" | jam convert --to base64\n`);
    process.stderr.write(`  echo "aGVsbG8=" | jam convert --from base64\n`);
    process.stderr.write(`  echo "hello world" | jam convert --to hex\n`);
    process.stderr.write(`  echo "hello%20world" | jam convert --from url\n`);
    return;
  }

  const fromFormat = options.from
    ? FORMAT_ALIASES[options.from.toLowerCase()]
    : detectFormat(input, file);

  const toFormat = options.to
    ? FORMAT_ALIASES[options.to.toLowerCase()]
    : null;

  // Encoding formats: if --from is set but --to isn't, decode to plain text
  const ENCODING_FORMATS: Format[] = ['base64', 'url', 'hex'];
  if (!toFormat && fromFormat && ENCODING_FORMATS.includes(fromFormat)) {
    if (fromFormat === 'base64') {
      process.stdout.write(Buffer.from(input.trim(), 'base64').toString('utf-8'));
      return;
    }
    if (fromFormat === 'url') {
      process.stdout.write(decodeURIComponent(input.trim()) + '\n');
      return;
    }
    if (fromFormat === 'hex') {
      process.stdout.write(Buffer.from(input.trim().replace(/\s/g, ''), 'hex').toString('utf-8'));
      return;
    }
  }

  if (!toFormat) {
    process.stderr.write('Specify output format with --to (json, yaml, csv, base64, url, hex)\n');
    process.exit(1);
    return;
  }

  // ── Encode/decode operations (no parsing needed) ───────────────────────

  // Base64 encode
  if (toFormat === 'base64' && fromFormat !== 'base64') {
    process.stdout.write(Buffer.from(input).toString('base64') + '\n');
    return;
  }

  // Base64 decode
  if (fromFormat === 'base64' && toFormat !== 'base64') {
    const decoded = Buffer.from(input.trim(), 'base64').toString('utf-8');
    if (toFormat === 'json' || toFormat === 'yaml') {
      // Try to parse as structured data
      try {
        const data: unknown = JSON.parse(decoded);
        process.stdout.write(toFormat === 'yaml' ? yaml.dump(data) : JSON.stringify(data, null, 2) + '\n');
        return;
      } catch { /* plain text */ }
    }
    process.stdout.write(decoded + '\n');
    return;
  }

  // URL encode
  if (toFormat === 'url') {
    process.stdout.write(encodeURIComponent(input.trim()) + '\n');
    return;
  }

  // URL decode
  if (fromFormat === 'url') {
    process.stdout.write(decodeURIComponent(input.trim()) + '\n');
    return;
  }

  // Hex encode
  if (toFormat === 'hex') {
    process.stdout.write(Buffer.from(input).toString('hex') + '\n');
    return;
  }

  // Hex decode
  if (fromFormat === 'hex') {
    const decoded = Buffer.from(input.trim().replace(/\s/g, ''), 'hex').toString('utf-8');
    process.stdout.write(decoded + '\n');
    return;
  }

  // ── Structured data conversions ────────────────────────────────────────

  let data: unknown;

  // Parse input
  switch (fromFormat) {
    case 'json':
      try {
        data = JSON.parse(input);
      } catch (err) {
        process.stderr.write(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
        return;
      }
      break;

    case 'yaml':
      try {
        data = yaml.load(input);
      } catch (err) {
        process.stderr.write(`Invalid YAML: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
        return;
      }
      break;

    case 'csv':
      data = parseCsv(input);
      break;

    default:
      process.stderr.write(`Cannot auto-detect input format. Use --from to specify.\n`);
      process.exit(1);
      return;
  }

  // Serialize output
  switch (toFormat) {
    case 'json':
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      break;

    case 'yaml':
      process.stdout.write(yaml.dump(data, { indent: 2, lineWidth: 120, noRefs: true }));
      break;

    case 'csv':
      try {
        process.stdout.write(toCsv(data) + '\n');
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }
      break;

    default:
      process.stderr.write(`Cannot convert structured data to ${toFormat}\n`);
      process.exit(1);
  }
}
