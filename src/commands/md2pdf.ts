/**
 * `jam md2pdf` — convert Markdown files to PDF.
 *
 * Uses marked (lexer) + pdfkit for lightweight, zero-browser PDF generation.
 * Supports headings, paragraphs, bold/italic/code, lists, code blocks,
 * blockquotes, horizontal rules, tables, and links.
 */

import { readFileSync, createWriteStream } from 'node:fs';
import { resolve, basename, dirname, extname } from 'node:path';
import chalk from 'chalk';
import { marked, type Token, type Tokens } from 'marked';
import PDFDocument from 'pdfkit';

// ── Options ──────────────────────────────────────────────────────────────────

export interface Md2PdfOptions {
  output?: string;
  title?: string;
  style?: string;
  fontSize?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const HEADING_SIZES: Record<number, number> = {
  1: 26, 2: 22, 3: 18, 4: 15, 5: 13, 6: 12,
};

const DEFAULT_BODY_SIZE = 11;
const CODE_SIZE_OFFSET = -1; // relative to body size
const PAGE_MARGIN = 72; // 1 inch

interface StyleConfig {
  fontFamily: string;
  boldFont: string;
  italicFont: string;
  boldItalicFont: string;
  codeFontFamily: string;
  headingColor: string;
  bodyColor: string;
  linkColor: string;
  codeBackground: string;
  blockquoteBorderColor: string;
  blockquoteTextColor: string;
  hrColor: string;
}

const STYLES: Record<string, StyleConfig> = {
  default: {
    fontFamily: 'Helvetica',
    boldFont: 'Helvetica-Bold',
    italicFont: 'Helvetica-Oblique',
    boldItalicFont: 'Helvetica-BoldOblique',
    codeFontFamily: 'Courier',
    headingColor: '#1a1a2e',
    bodyColor: '#333333',
    linkColor: '#2563eb',
    codeBackground: '#f3f4f6',
    blockquoteBorderColor: '#d1d5db',
    blockquoteTextColor: '#6b7280',
    hrColor: '#e5e7eb',
  },
  minimal: {
    fontFamily: 'Helvetica',
    boldFont: 'Helvetica-Bold',
    italicFont: 'Helvetica-Oblique',
    boldItalicFont: 'Helvetica-BoldOblique',
    codeFontFamily: 'Courier',
    headingColor: '#000000',
    bodyColor: '#000000',
    linkColor: '#000000',
    codeBackground: '#f5f5f5',
    blockquoteBorderColor: '#cccccc',
    blockquoteTextColor: '#666666',
    hrColor: '#cccccc',
  },
  academic: {
    fontFamily: 'Times-Roman',
    boldFont: 'Times-Bold',
    italicFont: 'Times-Italic',
    boldItalicFont: 'Times-BoldItalic',
    codeFontFamily: 'Courier',
    headingColor: '#000000',
    bodyColor: '#000000',
    linkColor: '#0000ee',
    codeBackground: '#f0f0f0',
    blockquoteBorderColor: '#999999',
    blockquoteTextColor: '#444444',
    hrColor: '#cccccc',
  },
};

// ── Inline text segment ──────────────────────────────────────────────────────

interface TextSegment {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
  link?: string;
}

function flattenInlineTokens(tokens: Token[]): TextSegment[] {
  const segments: TextSegment[] = [];

  function walk(list: Token[], bold: boolean, italic: boolean): void {
    for (const token of list) {
      switch (token.type) {
        case 'text': {
          const t = token as Tokens.Text;
          if ('tokens' in t && t.tokens && t.tokens.length > 0) {
            walk(t.tokens, bold, italic);
          } else {
            segments.push({ text: t.text, bold, italic, code: false });
          }
          break;
        }
        case 'strong': {
          const t = token as Tokens.Strong;
          walk(t.tokens, true, italic);
          break;
        }
        case 'em': {
          const t = token as Tokens.Em;
          walk(t.tokens, bold, true);
          break;
        }
        case 'codespan': {
          const t = token as Tokens.Codespan;
          segments.push({ text: t.text, bold: false, italic: false, code: true });
          break;
        }
        case 'link': {
          const t = token as Tokens.Link;
          const linkSegments: TextSegment[] = [];
          const prevLen = segments.length;
          walk(t.tokens, bold, italic);
          // Mark newly added segments as links
          for (let i = prevLen; i < segments.length; i++) {
            segments[i]!.link = t.href;
          }
          // If no segments were added (empty link), add href as text
          if (segments.length === prevLen) {
            linkSegments.push({ text: t.href, bold, italic, code: false, link: t.href });
            segments.push(...linkSegments);
          }
          break;
        }
        case 'image': {
          const t = token as Tokens.Image;
          segments.push({ text: `[Image: ${t.text || t.href}]`, bold: false, italic: true, code: false });
          break;
        }
        case 'br':
          segments.push({ text: '\n', bold: false, italic: false, code: false });
          break;
        default:
          if ('text' in token && typeof (token as { text: string }).text === 'string') {
            segments.push({ text: (token as { text: string }).text, bold, italic, code: false });
          }
          break;
      }
    }
  }

  walk(tokens, false, false);
  return segments;
}

// ── Resolve font for a segment ───────────────────────────────────────────────

function fontForSegment(segment: TextSegment, style: StyleConfig): string {
  if (segment.code) return style.codeFontFamily;
  if (segment.bold && segment.italic) return style.boldItalicFont;
  if (segment.bold) return style.boldFont;
  if (segment.italic) return style.italicFont;
  return style.fontFamily;
}

// ── Render segments as a text block ──────────────────────────────────────────

function renderSegments(
  doc: PDFKit.PDFDocument,
  segments: TextSegment[],
  style: StyleConfig,
  bodySize: number,
  options?: { indent?: number },
): void {
  const indent = options?.indent ?? 0;
  const codeSize = bodySize + CODE_SIZE_OFFSET;
  const x = PAGE_MARGIN + indent;
  const width = doc.page.width - PAGE_MARGIN * 2 - indent;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isLast = i === segments.length - 1;
    const font = fontForSegment(seg, style);
    const size = seg.code ? codeSize : bodySize;
    const color = seg.link ? style.linkColor : style.bodyColor;

    doc.font(font).fontSize(size).fillColor(color);

    const textOpts: PDFKit.Mixins.TextOptions = {
      continued: !isLast,
      lineGap: 4,
      width,
    };

    if (seg.link) {
      textOpts.link = seg.link;
      textOpts.underline = true;
    }

    if (i === 0) {
      doc.text(seg.text, x, undefined, textOpts);
    } else {
      doc.text(seg.text, textOpts);
    }
  }

  // If segments is empty, do nothing. If last segment had continued:true
  // pdfkit keeps state. We end with continued:false by default on the last seg.
}

// ── Page-break safety ────────────────────────────────────────────────────────

function ensureSpace(doc: PDFKit.PDFDocument, needed: number): void {
  const bottom = doc.page.height - PAGE_MARGIN;
  if (doc.y + needed > bottom) {
    doc.addPage();
  }
}

// ── Block-level renderers ────────────────────────────────────────────────────

function renderHeading(
  doc: PDFKit.PDFDocument, token: Tokens.Heading, style: StyleConfig, bodySize: number,
): void {
  const size = HEADING_SIZES[token.depth] ?? bodySize;
  ensureSpace(doc, size + 20);
  doc.moveDown(token.depth === 1 ? 0.8 : 0.5);

  doc.font(style.boldFont).fontSize(size).fillColor(style.headingColor);
  const segments = flattenInlineTokens(token.tokens);
  // Render heading segments — all forced bold
  const boldSegments = segments.map((s) => ({ ...s, bold: true }));
  renderSegments(doc, boldSegments, style, size);

  doc.moveDown(0.3);

  // Underline for h1 and h2
  if (token.depth <= 2) {
    const lineY = doc.y;
    doc
      .moveTo(PAGE_MARGIN, lineY)
      .lineTo(doc.page.width - PAGE_MARGIN, lineY)
      .strokeColor(style.hrColor)
      .lineWidth(token.depth === 1 ? 1.5 : 0.75)
      .stroke();
    doc.moveDown(0.3);
  }
}

function renderParagraph(
  doc: PDFKit.PDFDocument, token: Tokens.Paragraph, style: StyleConfig,
  bodySize: number, indent: number,
): void {
  doc.fontSize(bodySize).fillColor(style.bodyColor).font(style.fontFamily);
  const segments = flattenInlineTokens(token.tokens);
  renderSegments(doc, segments, style, bodySize, { indent });
  doc.moveDown(0.5);
}

function renderCodeBlock(
  doc: PDFKit.PDFDocument, token: Tokens.Code, style: StyleConfig,
  bodySize: number, indent: number,
): void {
  const codeSize = bodySize + CODE_SIZE_OFFSET;
  const padX = 8;
  const padY = 8;
  const codeX = PAGE_MARGIN + indent + padX;
  const codeWidth = doc.page.width - PAGE_MARGIN * 2 - indent - padX * 2;

  const textHeight = doc
    .font(style.codeFontFamily)
    .fontSize(codeSize)
    .heightOfString(token.text, { width: codeWidth });
  const bgHeight = textHeight + padY * 2;

  ensureSpace(doc, bgHeight + 10);

  const startY = doc.y;
  doc
    .roundedRect(PAGE_MARGIN + indent, startY, doc.page.width - PAGE_MARGIN * 2 - indent, bgHeight, 4)
    .fill(style.codeBackground);

  doc
    .font(style.codeFontFamily)
    .fontSize(codeSize)
    .fillColor(style.bodyColor)
    .text(token.text, codeX, startY + padY, { width: codeWidth });

  doc.y = startY + bgHeight;
  doc.x = PAGE_MARGIN;
  doc.moveDown(0.5);
}

function renderList(
  doc: PDFKit.PDFDocument, token: Tokens.List, style: StyleConfig,
  bodySize: number, indent: number,
): void {
  token.items.forEach((item, index) => {
    const bullet = token.ordered ? `${index + 1}.` : '\u2022';
    const bulletIndent = indent + 4;
    const textIndent = indent + 20;
    const _textWidth = doc.page.width - PAGE_MARGIN * 2 - textIndent;

    ensureSpace(doc, bodySize + 10);

    // Render bullet
    doc
      .font(style.fontFamily)
      .fontSize(bodySize)
      .fillColor(style.bodyColor)
      .text(bullet, PAGE_MARGIN + bulletIndent, doc.y, { continued: false, lineGap: 4 });

    // Move back up to place text beside bullet
    doc.y -= doc.currentLineHeight(true);

    // Render item content
    for (const subToken of item.tokens) {
      if (subToken.type === 'text' && 'tokens' in subToken && (subToken as Tokens.Text).tokens) {
        const segments = flattenInlineTokens((subToken as Tokens.Text).tokens!);
        renderSegments(doc, segments, style, bodySize, { indent: textIndent });
      } else if (subToken.type === 'paragraph') {
        const segments = flattenInlineTokens((subToken as Tokens.Paragraph).tokens);
        renderSegments(doc, segments, style, bodySize, { indent: textIndent });
      } else if (subToken.type === 'list') {
        renderList(doc, subToken as Tokens.List, style, bodySize, textIndent);
      }
    }

    doc.moveDown(0.15);
  });
  doc.moveDown(0.3);
}

function renderBlockquote(
  doc: PDFKit.PDFDocument, token: Tokens.Blockquote, style: StyleConfig,
  bodySize: number, indent: number,
): void {
  const barX = PAGE_MARGIN + indent;
  const textIndent = indent + 14;
  const startY = doc.y;

  doc.fillColor(style.blockquoteTextColor);

  for (const subToken of token.tokens) {
    if (subToken.type === 'paragraph') {
      const segments = flattenInlineTokens((subToken as Tokens.Paragraph).tokens);
      renderSegments(doc, segments, style, bodySize, { indent: textIndent });
      doc.moveDown(0.3);
    } else if (subToken.type === 'blockquote') {
      renderBlockquote(doc, subToken as Tokens.Blockquote, style, bodySize, textIndent);
    }
  }

  const endY = doc.y;

  // Draw vertical bar
  doc
    .moveTo(barX + 2, startY)
    .lineTo(barX + 2, endY - 4)
    .lineWidth(3)
    .strokeColor(style.blockquoteBorderColor)
    .stroke();

  doc.fillColor(style.bodyColor);
  doc.moveDown(0.2);
}

function renderHr(doc: PDFKit.PDFDocument, style: StyleConfig): void {
  doc.moveDown(0.5);
  ensureSpace(doc, 10);
  const y = doc.y;
  doc
    .moveTo(PAGE_MARGIN, y)
    .lineTo(doc.page.width - PAGE_MARGIN, y)
    .strokeColor(style.hrColor)
    .lineWidth(1)
    .stroke();
  doc.moveDown(0.5);
}

function renderTable(
  doc: PDFKit.PDFDocument, token: Tokens.Table, style: StyleConfig,
  bodySize: number,
): void {
  const tableWidth = doc.page.width - PAGE_MARGIN * 2;
  const colCount = token.header.length;
  const colWidth = tableWidth / colCount;
  const cellPad = 4;

  ensureSpace(doc, bodySize * 3);

  // Header row
  const headerY = doc.y;
  doc.font(style.boldFont).fontSize(bodySize).fillColor(style.headingColor);
  token.header.forEach((cell, i) => {
    const text = cell.tokens.map((t) => ('text' in t ? (t as { text: string }).text : '')).join('');
    doc.text(text, PAGE_MARGIN + i * colWidth + cellPad, headerY, {
      width: colWidth - cellPad * 2,
      continued: false,
    });
  });

  const afterHeaderY = headerY + doc.currentLineHeight(true) + 4;
  doc.y = afterHeaderY;

  // Header underline
  doc
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
    .strokeColor(style.hrColor)
    .lineWidth(1)
    .stroke();
  doc.moveDown(0.2);

  // Data rows
  doc.font(style.fontFamily).fontSize(bodySize).fillColor(style.bodyColor);
  for (const row of token.rows) {
    const rowY = doc.y;
    ensureSpace(doc, bodySize + 8);
    row.forEach((cell, i) => {
      const text = cell.tokens.map((t) => ('text' in t ? (t as { text: string }).text : '')).join('');
      doc.text(text, PAGE_MARGIN + i * colWidth + cellPad, rowY, {
        width: colWidth - cellPad * 2,
        continued: false,
      });
    });
    doc.y = rowY + doc.currentLineHeight(true) + 4;
  }

  doc.moveDown(0.5);
}

// ── Walk all block tokens ────────────────────────────────────────────────────

function renderTokens(
  doc: PDFKit.PDFDocument, tokens: Token[], style: StyleConfig,
  bodySize: number, indent: number,
): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'heading':
        renderHeading(doc, token as Tokens.Heading, style, bodySize);
        break;
      case 'paragraph':
        renderParagraph(doc, token as Tokens.Paragraph, style, bodySize, indent);
        break;
      case 'code':
        renderCodeBlock(doc, token as Tokens.Code, style, bodySize, indent);
        break;
      case 'list':
        renderList(doc, token as Tokens.List, style, bodySize, indent);
        break;
      case 'blockquote':
        renderBlockquote(doc, token as Tokens.Blockquote, style, bodySize, indent);
        break;
      case 'hr':
        renderHr(doc, style);
        break;
      case 'table':
        renderTable(doc, token as Tokens.Table, style, bodySize);
        break;
      case 'space':
        doc.moveDown(0.5);
        break;
      case 'html':
        // HTML blocks can't be rendered meaningfully in PDF — skip silently
        break;
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function runMd2Pdf(
  file: string | undefined,
  options: Md2PdfOptions,
): Promise<void> {
  if (!file) {
    process.stderr.write(`${chalk.bold('Usage')}: jam md2pdf <file.md> [options]\n\n`);
    process.stderr.write(`${chalk.bold('Options')}:\n`);
    process.stderr.write(`  -o, --output <path>    output file path (default: <input>.pdf)\n`);
    process.stderr.write(`  --title <title>        PDF document title\n`);
    process.stderr.write(`  --style <name>         style preset: default, minimal, academic\n`);
    process.stderr.write(`  --font-size <n>        body font size (default: 11)\n\n`);
    process.stderr.write(`${chalk.bold('Examples')}:\n`);
    process.stderr.write(`  jam md2pdf README.md\n`);
    process.stderr.write(`  jam md2pdf notes.md -o notes.pdf --style academic\n`);
    process.stderr.write(`  jam md2pdf spec.md --title "API Spec" --font-size 12\n`);
    return;
  }

  const inputPath = resolve(file);

  // Read markdown
  let markdown: string;
  try {
    markdown = readFileSync(inputPath, 'utf-8');
  } catch {
    process.stderr.write(chalk.red(`Error: Cannot read file: ${inputPath}\n`));
    process.exit(1);
    return;
  }

  // Resolve output path
  const outputPath = options.output
    ? resolve(options.output)
    : resolve(dirname(inputPath), basename(inputPath, extname(inputPath)) + '.pdf');

  // Resolve style
  const styleName = options.style ?? 'default';
  const style = STYLES[styleName];
  if (!style) {
    process.stderr.write(
      chalk.red(`Error: Unknown style "${styleName}". Choose from: ${Object.keys(STYLES).join(', ')}\n`),
    );
    process.exit(1);
    return;
  }

  const bodySize = options.fontSize ?? DEFAULT_BODY_SIZE;

  // Parse markdown tokens
  const tokens = marked.lexer(markdown);

  // Create PDF document
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
    info: {
      Title: options.title ?? basename(inputPath, extname(inputPath)),
      Creator: 'jam-cli md2pdf',
    },
    autoFirstPage: true,
    bufferPages: true,
  });

  const stream = createWriteStream(outputPath);
  doc.pipe(stream);

  // Render all tokens
  renderTokens(doc, tokens, style, bodySize, 0);

  // Finalize PDF
  doc.end();

  await new Promise<void>((res, rej) => {
    stream.on('finish', res);
    stream.on('error', rej);
  });

  process.stdout.write(
    `${chalk.green('\u2713')} ${chalk.bold(basename(inputPath))} \u2192 ${chalk.bold(basename(outputPath))}\n`,
  );
}
