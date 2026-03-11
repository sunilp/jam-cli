/**
 * `jam diagram` — generate architecture diagrams from code analysis.
 *
 * Two-phase approach:
 * 1. Analyze codebase structure (zero LLM) using shared analyzers
 * 2. Synthesize a Mermaid diagram via AI (or deterministic fallback with --no-ai)
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadConfig, getActiveProfile } from '../config/loader.js';
import { createProvider } from '../providers/factory.js';
import { withRetry, collectStream } from '../utils/stream.js';
import { streamToStdout, printError } from '../ui/renderer.js';
import { JamError } from '../utils/errors.js';
import { getWorkspaceRoot } from '../utils/workspace.js';
import { analyzeProject } from '../analyzers/structure.js';
import type { ProjectAnalysis } from '../analyzers/types.js';
import type { CliOverrides } from '../config/schema.js';

// ── Options ──────────────────────────────────────────────────────────────────

export type DiagramType = 'architecture' | 'deps' | 'flow' | 'class';

export interface DiagramOptions extends CliOverrides {
  type?: string;
  output?: string;
  noAi?: boolean;
  focus?: string;
  exclude?: string;
  noColor?: boolean;
  quiet?: boolean;
}

// ── Deterministic diagram generators (no AI) ─────────────────────────────────

function generateArchitectureDiagram(analysis: ProjectAnalysis, focus?: string): string {
  const lines: string[] = ['graph TD'];

  // Add modules as nodes
  for (const mod of analysis.modules) {
    const label = `${mod.name}[${mod.name}<br/>${mod.fileCount} files]`;
    lines.push(`  ${label}`);
  }

  // Add inter-module edges (top 20)
  const edges = focus
    ? analysis.interModuleDeps.filter((e) => e.from === focus || e.to === focus)
    : analysis.interModuleDeps.slice(0, 20);

  for (const edge of edges) {
    const label = edge.weight > 1 ? `|${edge.weight}|` : '';
    lines.push(`  ${edge.from} -->${label} ${edge.to}`);
  }

  // Style entry-point modules
  const entryModules = new Set<string>();
  for (const ep of analysis.entryPoints) {
    const parts = ep.split('/');
    if (parts[0] === 'src' && parts.length > 2) entryModules.add(parts[1]!);
    else entryModules.add('root');
  }
  if (entryModules.size > 0) {
    lines.push(`  classDef entry fill:#e0f2fe,stroke:#0284c7`);
    for (const mod of entryModules) {
      lines.push(`  class ${mod} entry`);
    }
  }

  // Highlight focus module
  if (focus) {
    lines.push(`  classDef focus fill:#fef3c7,stroke:#d97706,stroke-width:3px`);
    lines.push(`  class ${focus} focus`);
  }

  // Highlight cycles
  if (analysis.cycles.length > 0) {
    lines.push(`  classDef cyclic fill:#fee2e2,stroke:#dc2626`);
    const cyclicModules = new Set<string>();
    for (const cycle of analysis.cycles) {
      for (const file of cycle) {
        const parts = file.split('/');
        if (parts[0] === 'src' && parts.length > 2) cyclicModules.add(parts[1]!);
      }
    }
    for (const mod of cyclicModules) {
      lines.push(`  class ${mod} cyclic`);
    }
  }

  return lines.join('\n');
}

function generateDepsDiagram(analysis: ProjectAnalysis, focus?: string): string {
  const lines: string[] = ['graph LR'];

  // Show file-level deps for focused module, or inter-module for overview
  if (focus) {
    const mod = analysis.modules.find((m) => m.name === focus);
    if (mod) {
      for (const file of mod.files.slice(0, 30)) {
        const shortName = file.split('/').pop()!.replace(/\.[^.]+$/, '');
        const safeId = shortName.replace(/[^a-zA-Z0-9]/g, '_');
        lines.push(`  ${safeId}["${shortName}"]`);
      }
    }
  } else {
    for (const mod of analysis.modules) {
      lines.push(`  ${mod.name}((${mod.name}))`);
    }
    for (const edge of analysis.interModuleDeps.slice(0, 25)) {
      lines.push(`  ${edge.from} --> ${edge.to}`);
    }
  }

  return lines.join('\n');
}

function generateClassDiagram(analysis: ProjectAnalysis, focus?: string): string {
  const lines: string[] = ['classDiagram'];

  const symbols = focus
    ? analysis.symbols.filter((s) => s.module === focus)
    : analysis.symbols;

  const classes = symbols.filter((s) => s.kind === 'class');
  const interfaces = symbols.filter((s) => s.kind === 'interface');
  const enums = symbols.filter((s) => s.kind === 'enum');

  for (const cls of classes.slice(0, 20)) {
    lines.push(`  class ${cls.name}`);
  }

  for (const iface of interfaces.slice(0, 15)) {
    lines.push(`  class ${iface.name} {`);
    lines.push(`    <<interface>>`);
    lines.push(`  }`);
  }

  for (const en of enums.slice(0, 10)) {
    lines.push(`  class ${en.name} {`);
    lines.push(`    <<enumeration>>`);
    lines.push(`  }`);
  }

  return lines.join('\n');
}

function generateBasicDiagram(
  analysis: ProjectAnalysis, type: DiagramType, focus?: string,
): string {
  switch (type) {
    case 'architecture': return generateArchitectureDiagram(analysis, focus);
    case 'deps': return generateDepsDiagram(analysis, focus);
    case 'class': return generateClassDiagram(analysis, focus);
    case 'flow': return generateArchitectureDiagram(analysis, focus); // fallback
  }
}

// ── AI prompt builders ───────────────────────────────────────────────────────

function buildSystemPrompt(type: DiagramType): string {
  const base = [
    'You are a software architecture diagram generator.',
    'Given a project analysis as JSON, produce a Mermaid diagram.',
    '',
    'Rules:',
    '1. Output ONLY valid Mermaid syntax inside a ```mermaid code block. No other text.',
    '2. Use clear, concise labels. Abbreviate file paths to module names.',
    '3. For large projects, focus on the most important relationships (max 20 edges).',
    '4. Use styling to differentiate module types (entry points, utilities, core logic).',
    '5. Make the diagram readable — avoid too many crossing edges.',
  ];

  switch (type) {
    case 'architecture':
      base.push(
        '6. Use a graph TD (top-down) layout.',
        '7. Group related modules into subgraphs with descriptive labels.',
        '8. Show layers when applicable: UI → Commands → Core → Infrastructure.',
      );
      break;
    case 'deps':
      base.push(
        '6. Use a graph LR (left-right) layout for dependency flow.',
        '7. Show file-level dependencies within modules when focused.',
        '8. Use edge labels for import counts.',
      );
      break;
    case 'class':
      base.push(
        '6. Use a classDiagram.',
        '7. Show inheritance and implementation relationships.',
        '8. Include key methods and properties when relevant.',
      );
      break;
    case 'flow':
      base.push(
        '6. Use a flowchart TD layout.',
        '7. Show control flow between components.',
        '8. Highlight entry points and exit points.',
      );
      break;
  }

  return base.join('\n');
}

function buildUserPrompt(analysis: ProjectAnalysis, type: DiagramType, focus?: string): string {
  // Compact the analysis for the prompt
  const compact = {
    name: analysis.name,
    fileCount: analysis.fileCount,
    importCount: analysis.importCount,
    cycleCount: analysis.cycles.length,
    entryPoints: analysis.entryPoints.slice(0, 5),
    modules: analysis.modules.map((m) => ({
      name: m.name,
      files: m.fileCount,
      exports: m.exportedSymbols.slice(0, 10),
    })),
    dependencies: analysis.interModuleDeps.slice(0, 30),
    hotspots: analysis.hotspots.slice(0, 10),
    symbols: analysis.symbols
      .filter((s) => s.kind === 'class' || s.kind === 'interface')
      .slice(0, 30)
      .map((s) => ({ name: s.name, kind: s.kind, module: s.module })),
  };

  let prompt = `Generate a ${type} Mermaid diagram for this project:\n\n`;
  prompt += '```json\n' + JSON.stringify(compact, null, 2) + '\n```\n';

  if (focus) {
    prompt += `\nFocus on the "${focus}" module and its connections.`;
  }

  return prompt;
}

/**
 * Extract Mermaid code from AI response.
 */
function extractMermaid(response: string): string {
  // Try to extract from ```mermaid block
  const mermaidMatch = /```mermaid\n([\s\S]*?)```/.exec(response);
  if (mermaidMatch) return mermaidMatch[1]!.trim();

  // Try generic code block
  const codeMatch = /```\n?([\s\S]*?)```/.exec(response);
  if (codeMatch) return codeMatch[1]!.trim();

  // If starts with a known Mermaid keyword, use the whole response
  const trimmed = response.trim();
  if (/^(graph|flowchart|classDiagram|sequenceDiagram|stateDiagram|erDiagram)\b/.test(trimmed)) {
    return trimmed;
  }

  return trimmed;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function runDiagram(
  scope: string | undefined,
  options: DiagramOptions,
): Promise<void> {
  try {
    const workspaceRoot = await getWorkspaceRoot();
    const type = (options.type ?? 'architecture') as DiagramType;

    if (!['architecture', 'deps', 'flow', 'class'].includes(type)) {
      process.stderr.write(chalk.red(`Unknown diagram type: "${type}". Use: architecture, deps, flow, class\n`));
      process.exit(1);
      return;
    }

    const exclude = options.exclude?.split(',').map((s) => s.trim());

    // Phase 1: Analyze codebase
    if (!options.quiet) {
      process.stderr.write(chalk.dim('Analyzing codebase...\n'));
    }

    const analysis = analyzeProject(workspaceRoot, {
      srcDir: scope,
      exclude,
    });

    if (analysis.fileCount === 0) {
      process.stderr.write(chalk.yellow('No source files found.\n'));
      return;
    }

    if (!options.quiet) {
      process.stderr.write(
        chalk.dim(`Found ${analysis.fileCount} files, ${analysis.modules.length} modules, ${analysis.importCount} imports\n`),
      );
    }

    // JSON mode: output raw analysis
    if (options.json) {
      process.stdout.write(JSON.stringify(analysis, null, 2) + '\n');
      return;
    }

    // No-AI mode: generate deterministic diagram
    if (options.noAi) {
      const mermaid = generateBasicDiagram(analysis, type, options.focus);
      outputDiagram(mermaid, options.output, options.quiet);
      return;
    }

    // Phase 2: AI synthesis
    const config = await loadConfig(process.cwd(), options);
    const profile = getActiveProfile(config);
    const adapter = await createProvider(profile);

    const systemPrompt = buildSystemPrompt(type);
    const userPrompt = buildUserPrompt(analysis, type, options.focus);

    const request = {
      messages: [{ role: 'user' as const, content: userPrompt }],
      model: profile.model,
      temperature: 0.3, // Lower temperature for structured output
      maxTokens: profile.maxTokens,
      systemPrompt,
    };

    if (options.output) {
      // Collect full response, extract mermaid, write to file
      const { text } = await collectStream(
        withRetry(() => adapter.streamCompletion(request)),
      );
      const mermaid = extractMermaid(text);
      outputDiagram(mermaid, options.output, options.quiet);
    } else {
      // Stream to stdout
      const { text } = await streamToStdout(
        withRetry(() => adapter.streamCompletion(request)),
      );
      // If writing to terminal, the response is already printed
      // No extra output needed
      void text;
    }
  } catch (err) {
    const jamErr = JamError.fromUnknown(err);
    await printError(jamErr.message, jamErr.hint);
    process.exit(1);
  }
}

function outputDiagram(mermaid: string, outputPath?: string, quiet?: boolean): void {
  if (outputPath) {
    const resolved = resolve(outputPath);
    writeFileSync(resolved, mermaid + '\n');
    if (!quiet) {
      process.stderr.write(`${chalk.green('\u2713')} Diagram written to ${chalk.bold(outputPath)}\n`);
    }
  } else {
    process.stdout.write(mermaid + '\n');
  }
}
