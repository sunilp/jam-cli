// src/trace/formatter.ts
import type { TraceResult, UpstreamNode } from './graph.js';
import type { ImpactReport } from './impact.js';

// ── ASCII tree ───────────────────────────────────────────────────────────────

/**
 * Format a TraceResult as a readable ASCII tree.
 * Compatible with the format produced by `src/utils/call-graph.ts`.
 */
export function formatAsciiTree(result: TraceResult): string {
  const lines: string[] = [];
  const sym = result.symbol;

  if (result.notFound) {
    lines.push(`Symbol not found: ${sym.name}`);
    if (result.candidates && result.candidates.length > 0) {
      lines.push('');
      lines.push('  Did you mean:');
      for (const c of result.candidates) {
        lines.push(`  - ${c.name} (${c.kind}) in ${c.file}`);
      }
    }
    return lines.join('\n');
  }

  // Header
  const signature = sym.signature ? `${sym.name}${sym.signature}` : sym.name;
  const returnDisplay = sym.returnType || '(void)';
  lines.push(`${signature} → ${returnDisplay}`);
  lines.push(`  Defined: ${sym.file}:${sym.line}  [${sym.kind}]`);
  lines.push('');

  // Imports
  if (result.imports.length > 0) {
    lines.push('  Imported by:');
    for (const imp of result.imports) {
      const alias = imp.alias ? ` as ${imp.alias}` : '';
      lines.push(`  │ ${imp.file} (from ${imp.sourceModule}${alias})`);
    }
    lines.push('');
  }

  // Callers (inbound)
  if (result.callers.length > 0) {
    lines.push('  Called from:');
    for (let i = 0; i < result.callers.length; i++) {
      const c = result.callers[i]!;
      const prefix = i === result.callers.length - 1 ? '└─' : '├─';
      const argsDisplay = c.arguments ? `  args: (${c.arguments})` : '';
      lines.push(`  ${prefix} ${c.symbolName} [${c.symbolKind}] ${c.file}:${c.line}${argsDisplay}`);
    }
    lines.push('');
  }

  // Callees (outbound)
  if (result.callees.length > 0) {
    lines.push('  Calls into:');
    for (let i = 0; i < result.callees.length; i++) {
      const c = result.callees[i]!;
      const prefix = i === result.callees.length - 1 ? '└─' : '├─';
      const argsDisplay = c.arguments ? `(${c.arguments})` : '()';
      const target = c.file ? ` [${c.file}]` : '';
      lines.push(`  ${prefix} ${c.name}${argsDisplay}${target}`);
    }
    lines.push('');
  }

  // Upstream chain
  if (result.upstreamChain.length > 0) {
    lines.push('  Upstream call chain:');
    formatUpstreamTree(result.upstreamChain, lines, '  ');
    lines.push('');
  }

  return lines.join('\n');
}

function formatUpstreamTree(nodes: UpstreamNode[], lines: string[], indent: string): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const isLast = i === nodes.length - 1;
    const prefix = isLast ? '└─' : '├─';
    lines.push(`${indent}${prefix} ${node.name} (${node.file}:${node.line})`);
    if (node.callers.length > 0) {
      const childIndent = indent + (isLast ? '  ' : '│ ');
      formatUpstreamTree(node.callers, lines, childIndent);
    }
  }
}

// ── Mermaid flowchart ────────────────────────────────────────────────────────

/**
 * Format a TraceResult as a Mermaid flowchart diagram.
 * Compatible with the format produced by `src/utils/call-graph.ts`.
 */
export function formatMermaid(result: TraceResult): string {
  if (result.notFound) {
    return `graph TD\n  notfound["Symbol not found: ${result.symbol.name}"]`;
  }

  const lines: string[] = ['graph TD'];
  const sanitize = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, '_');
  const nodeId = (name: string, file: string) => sanitize(`${name}_${file.replace(/[/.]/g, '_')}`);

  const sym = result.symbol;
  const defId = nodeId(sym.name, sym.file);
  const shortFile = sym.file.split('/').slice(-2).join('/');
  lines.push(`  ${defId}["<b>${sym.name}</b><br/><i>${shortFile}:${sym.line}</i>"]`);

  // Callers → symbol
  const callerGroups = new Map<string, { file: string; line: number; kind: string; count: number }>();
  for (const caller of result.callers) {
    const key = `${caller.symbolName}@${caller.file}`;
    if (!callerGroups.has(key)) {
      callerGroups.set(key, { file: caller.file, line: caller.line, kind: caller.symbolKind, count: 1 });
    } else {
      callerGroups.get(key)!.count++;
    }
  }

  for (const [key, info] of callerGroups) {
    const callerName = key.split('@')[0]!;
    const id = nodeId(callerName, info.file);
    const sf = info.file.split('/').slice(-2).join('/');
    lines.push(`  ${id}["${callerName}<br/><i>${sf}:${info.line}</i>"]`);
    const label = info.count > 1 ? `|"${info.count}x"|` : '';
    lines.push(`  ${id} --> ${label}${defId}`);
  }

  // Symbol → callees
  for (const callee of result.callees) {
    const id = sanitize(`callee_${callee.name}`);
    const target = callee.file ? `<br/><i>${callee.file}</i>` : '';
    lines.push(`  ${id}["${callee.name}${target}"]`);
    lines.push(`  ${defId} --> ${id}`);
  }

  // Style
  lines.push('');
  lines.push(`  style ${defId} fill:#2563eb,color:#fff,stroke:#1d4ed8`);
  for (const [key, info] of callerGroups) {
    const callerName = key.split('@')[0]!;
    lines.push(`  style ${nodeId(callerName, info.file)} fill:#059669,color:#fff,stroke:#047857`);
  }
  for (const callee of result.callees) {
    lines.push(`  style ${sanitize(`callee_${callee.name}`)} fill:#d97706,color:#fff,stroke:#b45309`);
  }

  return lines.join('\n');
}

// ── AI-friendly markdown ─────────────────────────────────────────────────────

/**
 * Format a TraceResult as markdown for LLM consumption.
 * Includes token budget truncation (default 8000 chars).
 * If the full graph exceeds the budget, only immediate callers/callees
 * are included and deeper nodes are summarized as counts.
 */
export function formatGraphForAI(result: TraceResult, maxTokens = 8000): string {
  if (result.notFound) {
    let text = `# Symbol Not Found: ${result.symbol.name}\n`;
    if (result.candidates && result.candidates.length > 0) {
      text += '\n## Did you mean?\n';
      for (const c of result.candidates) {
        text += `- **${c.name}** (${c.kind}) in \`${c.file}\`\n`;
      }
    }
    return text;
  }

  const sections: string[] = [];
  const sym = result.symbol;

  sections.push(`# Call Graph: ${sym.name}`);
  sections.push('');
  sections.push(`**Definition:** \`${sym.file}:${sym.line}\` (${sym.kind})`);
  const signature = sym.signature ? `${sym.name}${sym.signature}` : sym.name;
  sections.push(`**Signature:** \`${signature}\` → \`${sym.returnType || 'void'}\``);
  sections.push(`**Language:** ${sym.language}`);
  sections.push('');

  // Check if we need to truncate
  const fullOutput = buildFullAIOutput(result, sections);
  if (fullOutput.length <= maxTokens) {
    return fullOutput;
  }

  // Truncated version: immediate callers/callees only, summarize deeper nodes
  if (result.imports.length > 0) {
    sections.push('## Imported by');
    for (const imp of result.imports.slice(0, 10)) {
      sections.push(`- \`${imp.file}\` from \`${imp.sourceModule}\``);
    }
    if (result.imports.length > 10) {
      sections.push(`- ... and ${result.imports.length - 10} more`);
    }
    sections.push('');
  }

  if (result.callers.length > 0) {
    sections.push('## Direct Callers');
    for (const c of result.callers.slice(0, 10)) {
      sections.push(`- \`${c.symbolName}\` (${c.symbolKind}) at \`${c.file}:${c.line}\``);
    }
    if (result.callers.length > 10) {
      sections.push(`- ... and ${result.callers.length - 10} more callers`);
    }
    sections.push('');
  }

  if (result.callees.length > 0) {
    sections.push('## Outgoing Calls');
    for (const c of result.callees.slice(0, 10)) {
      sections.push(`- \`${c.name}\`${c.file ? ` in \`${c.file}\`` : ''}`);
    }
    if (result.callees.length > 10) {
      sections.push(`- ... and ${result.callees.length - 10} more callees`);
    }
    sections.push('');
  }

  if (result.upstreamChain.length > 0) {
    const totalUpstream = countUpstreamNodes(result.upstreamChain);
    sections.push(`## Upstream Chain (${totalUpstream} nodes total)`);
    // Only show first level
    for (const node of result.upstreamChain.slice(0, 5)) {
      const subCount = countUpstreamNodes(node.callers);
      const sub = subCount > 0 ? ` (${subCount} upstream)` : '';
      sections.push(`- \`${node.name}\` at \`${node.file}:${node.line}\`${sub}`);
    }
    if (result.upstreamChain.length > 5) {
      sections.push(`- ... and ${result.upstreamChain.length - 5} more`);
    }
    sections.push('');
  }

  return sections.join('\n');
}

function buildFullAIOutput(result: TraceResult, header: string[]): string {
  const sections = [...header];

  if (result.imports.length > 0) {
    sections.push('## Imported by');
    for (const imp of result.imports) {
      sections.push(`- \`${imp.file}\` from \`${imp.sourceModule}\``);
    }
    sections.push('');
  }

  if (result.callers.length > 0) {
    sections.push('## Call Sites (inbound)');
    for (const c of result.callers) {
      const argsDisplay = c.arguments ? ` with args: \`${c.arguments}\`` : '';
      sections.push(`- \`${c.symbolName}\` (${c.symbolKind}) at \`${c.file}:${c.line}\`${argsDisplay}`);
    }
    sections.push('');
  }

  if (result.callees.length > 0) {
    sections.push('## Outgoing Calls');
    for (const c of result.callees) {
      const argsDisplay = c.arguments ? `(${c.arguments})` : '()';
      sections.push(`- \`${c.name}${argsDisplay}\`${c.file ? ` → \`${c.file}\`` : ''}`);
    }
    sections.push('');
  }

  if (result.upstreamChain.length > 0) {
    sections.push('## Upstream Call Chain');
    formatUpstreamMarkdown(result.upstreamChain, sections, 0);
    sections.push('');
  }

  return sections.join('\n');
}

function formatUpstreamMarkdown(nodes: UpstreamNode[], sections: string[], depth: number): void {
  const indent = '  '.repeat(depth);
  for (const node of nodes) {
    sections.push(`${indent}- \`${node.name}\` (${node.file}:${node.line})`);
    if (node.callers.length > 0) {
      formatUpstreamMarkdown(node.callers, sections, depth + 1);
    }
  }
}

function countUpstreamNodes(nodes: UpstreamNode[]): number {
  let count = nodes.length;
  for (const node of nodes) {
    count += countUpstreamNodes(node.callers);
  }
  return count;
}

// ── Impact report ────────────────────────────────────────────────────────────

/**
 * Format an ImpactReport as a structured text report.
 */
export function formatImpactReport(report: ImpactReport): string {
  const lines: string[] = [];
  const sym = report.symbol;

  // Header with risk badge
  const riskBadge = `[${report.riskLevel}]`;
  lines.push(`Impact Analysis: ${sym.name} ${riskBadge}`);
  lines.push('='.repeat(lines[0]!.length));
  lines.push('');
  lines.push(`  Symbol: ${sym.name} (${sym.kind})`);
  lines.push(`  File:   ${sym.file}`);
  lines.push(`  Lang:   ${sym.language}`);
  lines.push(`  Risk:   ${report.riskLevel} — ${report.riskReason}`);
  lines.push('');

  // Direct callers
  if (report.directCallers.length > 0) {
    lines.push(`  Direct callers (${report.directCallers.length}):`);
    for (const caller of report.directCallers) {
      lines.push(`    - ${caller.name} (${caller.language}) at ${caller.file}:${caller.line}`);
    }
    lines.push('');
  } else {
    lines.push('  Direct callers: none');
    lines.push('');
  }

  // Column dependents
  if (report.columnDependents.length > 0) {
    lines.push(`  Column dependents (${report.columnDependents.length}):`);
    for (const dep of report.columnDependents) {
      lines.push(`    - ${dep.symbolName} ${dep.operation}s ${dep.tableName}.${dep.columnName} (${dep.file})`);
    }
    lines.push('');
  }

  // Downstream effects
  if (report.downstreamEffects.length > 0) {
    lines.push(`  Downstream effects (${report.downstreamEffects.length}):`);
    for (const effect of report.downstreamEffects) {
      lines.push(`    - ${effect.symbolName} reads ${effect.tableName}.${effect.columnName} (${effect.file})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
