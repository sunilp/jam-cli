import chalk from 'chalk';
import type { CliOverrides } from '../config/schema.js';

export interface IntelScanOptions extends CliOverrides {
  enrich?: string;    // 'shallow' | 'deep' | undefined (--no-enrich sets to 'none' logically via absence)
  noEnrich?: boolean; // set by --no-enrich flag
  dryRun?: boolean;
}

export async function runIntelScan(options: IntelScanOptions): Promise<void> {
  const { Scanner, saveGraph, saveMermaid, loadGraph, checkGitignore,
          generateArchitectureDiagram, generateViewerHtml, openInBrowser } = await import('../intel/index.js');
  const { getWorkspaceRoot } = await import('../utils/workspace.js');
  const { loadConfig, getActiveProfile } = await import('../config/loader.js');

  const rootDir = await getWorkspaceRoot();
  const config = await loadConfig(process.cwd(), options);
  const intelConfig = config.intel;

  // Load previous graph for incremental scan
  const previousGraph = await loadGraph(rootDir);

  // Scan
  const scanner = new Scanner();
  console.log(chalk.yellow('⚡ Scanning codebase...'));
  const startTime = Date.now();
  const graph = await scanner.scan(rootDir, {
    previousGraph: previousGraph ?? undefined,
    excludePatterns: intelConfig.excludePatterns,
  });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(chalk.green(`⚡ Structural scan... ${graph.getStats().fileCount} files, ${graph.nodeCount} nodes, ${graph.edgeCount} edges (${elapsed}s)`));

  if (graph.frameworks.length > 0) {
    console.log(chalk.cyan(`🔧 Frameworks detected: ${graph.frameworks.join(', ')}`));
  }

  // Dry run — just show estimate
  if (options.dryRun) {
    const depth = (typeof options.enrich === 'string' ? options.enrich : intelConfig.enrichDepth) as 'shallow' | 'deep';
    const tokens = graph.estimateTokens(depth);
    console.log(chalk.blue(`📊 Estimated tokens for ${depth} enrichment: ~${tokens.toLocaleString()}`));
    return;
  }

  // Save graph
  await saveGraph(graph, rootDir);
  console.log(chalk.dim(`💾 Saved to .jam/intel/graph.json`));

  // Gitignore warning
  if (!checkGitignore(rootDir)) {
    console.log(chalk.yellow('⚠️  Consider adding .jam/intel/ to .gitignore'));
  }

  // Generate architecture diagram
  const mermaid = generateArchitectureDiagram(graph);
  const mmdPath = await saveMermaid(mermaid, rootDir);
  console.log(chalk.green('🏗️  Architecture diagram generated'));

  // Open in browser if configured
  if (intelConfig.openBrowserOnScan) {
    const fsPromises = await import('node:fs/promises');
    const nodePath = await import('node:path');
    const htmlContent = generateViewerHtml(mermaid, mmdPath);
    const htmlPath = nodePath.join(nodePath.dirname(mmdPath), 'viewer.html');
    await fsPromises.writeFile(htmlPath, htmlContent);
    await openInBrowser(htmlPath);
    console.log(chalk.green('🌐 Opened in browser'));
  }

  // LLM enrichment (unless --no-enrich)
  const enrichDepth = options.noEnrich ? 'none'
    : typeof options.enrich === 'string' ? options.enrich
    : intelConfig.enrichDepth;

  if (enrichDepth !== 'none') {
    try {
      const { createProvider } = await import('../providers/factory.js');
      const profile = getActiveProfile(config);
      const provider = await createProvider(profile);
      const { EnrichmentEngine } = await import('../intel/index.js');
      const { saveEnrichment } = await import('../intel/index.js');

      const engine = new EnrichmentEngine(provider);
      const tokens = graph.estimateTokens(enrichDepth as 'shallow' | 'deep');
      console.log(chalk.blue(`🧠 LLM enrichment started (est. ~${tokens.toLocaleString()} tokens)`));

      const entries = await engine.enrichAll(graph, {
        depth: enrichDepth as 'shallow' | 'deep',
        maxTokenBudget: intelConfig.maxTokenBudget,
        onProgress: (progress) => {
          if (Math.round(progress * 100) % 10 === 0) {
            process.stdout.write(chalk.dim(`\r  ${Math.round(progress * 100)}% enriched`));
          }
        },
      });

      console.log('');
      await saveEnrichment(entries, { depth: enrichDepth as 'shallow' | 'deep', tokensUsed: 0 }, rootDir);
      console.log(chalk.green(`🧠 Enrichment complete — ${entries.length} nodes enriched`));
    } catch (err) {
      console.log(chalk.yellow(`⚠️  Enrichment skipped: ${err instanceof Error ? err.message : 'provider unavailable'}`));
    }
  }
}

export async function runIntelStatus(): Promise<void> {
  const { loadGraph, loadEnrichment } = await import('../intel/index.js');
  const { getWorkspaceRoot } = await import('../utils/workspace.js');

  const rootDir = await getWorkspaceRoot();
  const graph = await loadGraph(rootDir);

  if (!graph) {
    console.log(chalk.yellow('No knowledge graph found. Run `jam intel scan` first.'));
    return;
  }

  const stats = graph.getStats();
  const enrichment = await loadEnrichment(rootDir);

  console.log(chalk.bold('jam intel status'));
  console.log(`  Nodes: ${stats.nodeCount}`);
  console.log(`  Edges: ${stats.edgeCount}`);
  console.log(`  Files: ${stats.fileCount}`);
  console.log(`  Languages: ${stats.languages.join(', ') || 'none'}`);
  console.log(`  Frameworks: ${stats.frameworks.join(', ') || 'none'}`);

  if (enrichment) {
    const pct = Math.round((enrichment.entries.length / stats.nodeCount) * 100);
    console.log(`  Enrichment: ${pct}% (${enrichment.entries.length}/${stats.nodeCount} nodes)`);
    console.log(`  Tokens used: ${enrichment.tokensUsed.toLocaleString()}`);
  } else {
    console.log(`  Enrichment: none`);
  }
}

export async function runIntelQuery(text: string, options: { noAi?: boolean; mermaid?: boolean; profile?: string; provider?: string; model?: string; baseUrl?: string }): Promise<void> {
  const { loadGraph, loadEnrichment, query } = await import('../intel/index.js');
  const { getWorkspaceRoot } = await import('../utils/workspace.js');

  const rootDir = await getWorkspaceRoot();
  const graph = await loadGraph(rootDir);
  if (!graph) { console.log(chalk.yellow('No graph. Run `jam intel scan` first.')); return; }

  const enrichment = await loadEnrichment(rootDir);

  let provider = null;
  if (!options.noAi) {
    try {
      const { loadConfig, getActiveProfile } = await import('../config/loader.js');
      const { createProvider } = await import('../providers/factory.js');
      const config = await loadConfig(process.cwd(), options);
      const profile = getActiveProfile(config);
      provider = await createProvider(profile);
    } catch { /* fall back to offline */ }
  }

  const result = await query(text, graph, enrichment?.entries ?? [], provider, { noAi: options.noAi, mermaid: options.mermaid });

  if (result.explanation) console.log(result.explanation);
  if (result.nodes.length > 0 && !result.explanation) {
    console.log(chalk.bold(`Found ${result.nodes.length} matching nodes:`));
    for (const node of result.nodes) {
      console.log(`  ${chalk.cyan(node.type)} ${node.name}${node.filePath ? chalk.dim(` (${node.filePath})`) : ''}`);
    }
  }
  if (result.mermaid) { console.log('\n' + result.mermaid); }
  if (result.nodes.length === 0 && !result.explanation) { console.log(chalk.yellow('No results found.')); }
}

export async function runIntelImpact(file: string, options: { mermaid?: boolean }): Promise<void> {
  const { loadGraph, generateImpactDiagram } = await import('../intel/index.js');
  const { getWorkspaceRoot } = await import('../utils/workspace.js');
  const nodePath = await import('node:path');

  const rootDir = await getWorkspaceRoot();
  const graph = await loadGraph(rootDir);
  if (!graph) { console.log(chalk.yellow('No graph. Run `jam intel scan` first.')); return; }

  const relFile = nodePath.relative(rootDir, file).replace(/\\/g, '/');
  const nodeId = `file:${relFile}`;
  const node = graph.getNode(nodeId);
  if (!node) { console.log(chalk.yellow(`Node not found: ${nodeId}`)); return; }

  const impacted = graph.getImpactSubgraph(nodeId);

  if (impacted.length === 0) {
    console.log(chalk.green('No other files depend on this.'));
    return;
  }

  console.log(chalk.bold(`Impact analysis for ${relFile}:`));
  console.log(`  ${impacted.length} files affected:\n`);
  for (const n of impacted) {
    console.log(`  ${chalk.cyan(n.type)} ${n.name}${n.filePath ? chalk.dim(` (${n.filePath})`) : ''}`);
  }

  if (options.mermaid) {
    console.log('\n' + generateImpactDiagram(graph, nodeId));
  }
}

export async function runIntelDiagram(options: { type?: string; output?: string }): Promise<void> {
  const { loadGraph, generateArchitectureDiagram, generateDepsDiagram, generateFlowDiagram, generateFrameworkDiagram } = await import('../intel/index.js');
  const { getWorkspaceRoot } = await import('../utils/workspace.js');

  const rootDir = await getWorkspaceRoot();
  const graph = await loadGraph(rootDir);
  if (!graph) { console.log(chalk.yellow('No graph. Run `jam intel scan` first.')); return; }

  const type = options.type ?? 'architecture';
  let mermaid: string;
  switch (type) {
    case 'architecture': mermaid = generateArchitectureDiagram(graph); break;
    case 'deps': mermaid = generateDepsDiagram(graph); break;
    case 'flow': mermaid = generateFlowDiagram(graph); break;
    case 'framework': mermaid = generateFrameworkDiagram(graph); break;
    default: console.log(chalk.yellow(`Unknown type: ${type}`)); return;
  }

  if (options.output) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(options.output, mermaid);
    console.log(chalk.green(`Diagram saved to ${options.output}`));
  } else {
    console.log(mermaid);
  }
}

export async function runIntelExplore(): Promise<void> {
  const { loadGraph, generateArchitectureDiagram, saveMermaid, generateViewerHtml, openInBrowser } = await import('../intel/index.js');
  const { getWorkspaceRoot } = await import('../utils/workspace.js');
  const fsPromises = await import('node:fs/promises');
  const nodePath = await import('node:path');

  const rootDir = await getWorkspaceRoot();
  const graph = await loadGraph(rootDir);
  if (!graph) { console.log(chalk.yellow('No graph. Run `jam intel scan` first.')); return; }

  const mermaid = generateArchitectureDiagram(graph);
  const mmdPath = await saveMermaid(mermaid, rootDir);
  const htmlContent = generateViewerHtml(mermaid, mmdPath);
  const htmlPath = nodePath.join(nodePath.dirname(mmdPath), 'viewer.html');
  await fsPromises.writeFile(htmlPath, htmlContent);
  await openInBrowser(htmlPath);
  console.log(chalk.green('🌐 Explorer opened in browser'));
}
