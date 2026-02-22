/**
 * JAM — ASCII logo and banner
 *
 * Plain text version is embedded in the README and shown in `--help`.
 * The coloured version (ANSI escape codes, no deps) is shown at startup.
 */

// ── Raw letter art (block-character figlet style) ────────────────────────────

const LETTERS = [
  '     ██╗  █████╗  ███╗   ███╗',
  '     ██║ ██╔══██╗ ████╗ ████║',
  '     ██║ ███████║ ██╔████╔██║',
  ' ██  ██║ ██╔══██║ ██║╚██╔╝██║',
  ' ╚████╔╝ ██║  ██║ ██║ ╚═╝ ██║',
  '  ╚═══╝  ╚═╝  ╚═╝ ╚═╝     ╚═╝',
];

const TAGLINE = 'developer-first  AI  CLI';
const PAD = 3; // spaces between content and border │

// ── ANSI helpers (no deps — safe to call synchronously) ─────────────────────

const A = {
  reset:   '\x1b[0m',
  dim:     '\x1b[2m',
  bold:    '\x1b[1m',
  gold:    '\x1b[38;2;255;215;0m',   // #FFD700
  muted:   '\x1b[38;2;136;136;136m', // #888
} as const;

function ansi(code: string, text: string): string {
  return `${code}${text}${A.reset}`;
}

// ── Computed dimensions ───────────────────────────────────────────────────────

const contentWidth = Math.max(...LETTERS.map(l => l.length), TAGLINE.length);
const innerWidth   = contentWidth + PAD * 2;
const hr           = '─'.repeat(innerWidth);
const tagPad       = ' '.repeat(Math.floor((contentWidth - TAGLINE.length) / 2));

// ── Build plain box ──────────────────────────────────────────────────────────

function buildPlain(): string {
  const border = (s: string) => `│ ${s.padEnd(innerWidth - 2)} │`;
  const blank  = `│${' '.repeat(innerWidth)}│`;

  return [
    `╭${hr}╮`,
    blank,
    ...LETTERS.map(border),
    blank,
    border(`${tagPad}${TAGLINE}`),
    blank,
    `╰${hr}╯`,
  ].join('\n');
}

// ── Build coloured box (synchronous ANSI, no chalk needed) ──────────────────

// Strip ANSI escape codes to get the visible (printable) length of a string.
const visibleLength = (s: string): number =>
  s.replace(/\x1b\[[0-9;]*m/g, '').length;

function buildColored(): string {
  const pad   = (s: string) => s + ' '.repeat(Math.max(0, innerWidth - 2 - visibleLength(s)));
  const blank = ansi(A.dim, `│${' '.repeat(innerWidth)}│`);

  const boxLine = (middle: string) =>
    ansi(A.dim, '│ ') + middle + ansi(A.dim, ' │');

  const letterLines = LETTERS.map(l =>
    boxLine(pad(ansi(A.bold + A.gold, l)))
  );

  const tagContent = `${tagPad}${ansi(A.muted, TAGLINE)}`;

  return [
    ansi(A.dim, `╭${hr}╮`),
    blank,
    ...letterLines,
    blank,
    boxLine(pad(tagContent)),
    blank,
    ansi(A.dim, `╰${hr}╯`),
  ].join('\n');
}

// ── Public exports ───────────────────────────────────────────────────────────

/** Plain-text logo — used in README and non-TTY environments. */
export const LOGO_PLAIN = buildPlain();

/**
 * Print the logo banner to stdout.
 * Automatically uses ANSI colours when stdout is a TTY.
 */
export function printLogo(noColor = false): void {
  const useColor = !noColor && process.stdout.isTTY;
  process.stdout.write((useColor ? buildColored() : LOGO_PLAIN) + '\n\n');
}
