// src/intel/mermaid.ts

import type { IntelGraph } from './graph.js';
import type { IntelNode, IntelEdge, EdgeType } from './types.js';

// ── Node ID sanitization ────────────────────────────────────────────────────

/**
 * Sanitize a string so it can be used as a Mermaid node identifier.
 * Replaces spaces, colons, slashes, and other special chars with underscores.
 */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Format a node as a Mermaid shape based on its type.
 *
 * Shape conventions:
 *   modules  → [label]         (box/rectangle)
 *   services → ([label])       (rounded rectangle)
 *   endpoints→ {{label}}       (hexagon)
 *   tables   → [(label)]       (cylinder)
 *   external → >label]         (flag)
 *   others   → [label]         (box, default)
 */
function nodeShape(node: IntelNode): string {
  const safeId = sanitizeId(node.id);
  const label = node.name.replace(/"/g, "'");
  switch (node.type) {
    case 'service':
      return `${safeId}(["${label}"])`;
    case 'endpoint':
      return `${safeId}{{"${label}"}}`;
    case 'table':
      return `${safeId}[("${label}")]`;
    case 'external':
      return `${safeId}>"${label}"]`;
    default:
      return `${safeId}["${label}"]`;
  }
}

/**
 * Map an EdgeType to a Mermaid arrow style.
 */
function edgeArrow(type: EdgeType): string {
  switch (type) {
    case 'imports':
    case 'calls':
    case 'consumes':
      return '-->';
    case 'reads':
      return '-..->';
    case 'writes':
      return '==>';
    case 'publishes':
    case 'subscribes':
      return '-.->';
    case 'exposes':
    case 'contains':
      return '-->';
    case 'depends-on':
    case 'deploys-with':
    case 'configures':
      return '--->';
    default:
      return '-->';
  }
}

// ── Architecture Diagram (graph TD) ────────────────────────────────────────

/**
 * Generate an architecture overview diagram using Mermaid graph TD.
 * Groups file/function/class nodes by module (top-level directory or file stem).
 * Shows service, endpoint, table, external nodes at the top level.
 */
export function generateArchitectureDiagram(graph: IntelGraph): string {
  const lines: string[] = ['graph TD'];

  // Group file nodes by their top-level directory/module
  const fileNodes = graph.filterByType('file');
  const modules = new Map<string, IntelNode[]>();

  for (const node of fileNodes) {
    const fp = node.filePath ?? node.name;
    const parts = fp.split('/');
    const module = parts.length > 1 ? parts[0]! : 'root';
    const list = modules.get(module) ?? [];
    list.push(node);
    modules.set(module, list);
  }

  // Emit subgraphs for each module
  for (const [moduleName, nodes] of modules) {
    const safeModule = sanitizeId(moduleName);
    lines.push(`  subgraph ${safeModule}["${moduleName}"]`);
    for (const n of nodes) {
      lines.push(`    ${nodeShape(n)}`);
    }
    lines.push('  end');
  }

  // Emit non-file, non-function, non-class nodes at top level
  const topLevelTypes = new Set(['service', 'endpoint', 'table', 'external', 'schema', 'queue', 'event', 'config']);
  for (const node of graph.allNodes()) {
    if (topLevelTypes.has(node.type)) {
      lines.push(`  ${nodeShape(node)}`);
    }
  }

  // Emit edges (deduplicated by source→target)
  const seenEdges = new Set<string>();
  for (const edge of graph.allEdges()) {
    const key = `${edge.source}→${edge.target}→${edge.type}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);

    const src = sanitizeId(edge.source);
    const tgt = sanitizeId(edge.target);
    const arrow = edgeArrow(edge.type);
    lines.push(`  ${src} ${arrow}|"${edge.type}"| ${tgt}`);
  }

  return lines.join('\n');
}

// ── Deps Diagram (graph LR) ─────────────────────────────────────────────────

/**
 * Generate a dependency diagram (LR) focused on imports/calls between modules.
 * If focus is provided, only show nodes reachable from the focused node.
 */
export function generateDepsDiagram(graph: IntelGraph, focus?: string): string {
  const lines: string[] = ['graph LR'];

  let nodesToShow: IntelNode[];
  if (focus) {
    const focal = graph.getNode(focus);
    if (!focal) {
      nodesToShow = graph.allNodes();
    } else {
      // Show focal node + its direct neighbors (outgoing)
      const neighbors = graph.getNeighbors(focus, 'outgoing');
      nodesToShow = [focal, ...neighbors];
    }
  } else {
    nodesToShow = graph.allNodes();
  }

  const nodeIdSet = new Set(nodesToShow.map(n => n.id));

  // Emit nodes
  for (const node of nodesToShow) {
    lines.push(`  ${nodeShape(node)}`);
  }

  // Emit import/call/depends-on edges
  const depEdgeTypes: Set<EdgeType> = new Set(['imports', 'calls', 'depends-on', 'consumes']);
  const seenEdges = new Set<string>();
  for (const edge of graph.allEdges()) {
    if (!depEdgeTypes.has(edge.type)) continue;
    if (!nodeIdSet.has(edge.source) || !nodeIdSet.has(edge.target)) continue;

    const key = `${edge.source}→${edge.target}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);

    const src = sanitizeId(edge.source);
    const tgt = sanitizeId(edge.target);
    lines.push(`  ${src} --> ${tgt}`);
  }

  return lines.join('\n');
}

// ── Flow Diagram (graph LR, data flow) ──────────────────────────────────────

/**
 * Generate a data-flow diagram showing only reads/writes/publishes/subscribes edges.
 */
export function generateFlowDiagram(graph: IntelGraph): string {
  const lines: string[] = ['graph LR'];

  const flowEdgeTypes: Set<EdgeType> = new Set(['reads', 'writes', 'publishes', 'subscribes']);

  // Collect only nodes that participate in flow edges
  const participatingNodeIds = new Set<string>();
  for (const edge of graph.allEdges()) {
    if (flowEdgeTypes.has(edge.type)) {
      participatingNodeIds.add(edge.source);
      participatingNodeIds.add(edge.target);
    }
  }

  // Emit participating nodes
  for (const nodeId of participatingNodeIds) {
    const node = graph.getNode(nodeId);
    if (node) {
      lines.push(`  ${nodeShape(node)}`);
    }
  }

  // Emit flow edges
  const seenEdges = new Set<string>();
  for (const edge of graph.allEdges()) {
    if (!flowEdgeTypes.has(edge.type)) continue;

    const key = `${edge.source}→${edge.target}→${edge.type}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);

    const src = sanitizeId(edge.source);
    const tgt = sanitizeId(edge.target);
    const arrow = edgeArrow(edge.type);
    lines.push(`  ${src} ${arrow}|"${edge.type}"| ${tgt}`);
  }

  return lines.join('\n');
}

// ── Impact Diagram ──────────────────────────────────────────────────────────

/**
 * Generate an impact diagram showing which nodes are affected by a change to targetNodeId.
 * Highlights the target node and its transitive dependents with red styling.
 */
export function generateImpactDiagram(graph: IntelGraph, targetNodeId: string): string {
  const lines: string[] = ['graph TD'];

  const target = graph.getNode(targetNodeId);
  if (!target) {
    lines.push(`  %% Node "${targetNodeId}" not found`);
    return lines.join('\n');
  }

  // Get the impact subgraph (all nodes that depend on target)
  const impacted = graph.getImpactSubgraph(targetNodeId);
  const allRelevant = [target, ...impacted];
  const relevantIds = new Set(allRelevant.map(n => n.id));

  // Emit nodes
  for (const node of allRelevant) {
    lines.push(`  ${nodeShape(node)}`);
  }

  // Emit edges between relevant nodes
  const seenEdges = new Set<string>();
  for (const edge of graph.allEdges()) {
    if (!relevantIds.has(edge.source) || !relevantIds.has(edge.target)) continue;

    const key = `${edge.source}→${edge.target}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);

    const src = sanitizeId(edge.source);
    const tgt = sanitizeId(edge.target);
    lines.push(`  ${src} --> ${tgt}`);
  }

  // Style: highlight target in red, impacted in orange
  const targetSafeId = sanitizeId(targetNodeId);
  lines.push(`  style ${targetSafeId} fill:#f96,stroke:#333,stroke-width:2px`);
  for (const node of impacted) {
    const safeId = sanitizeId(node.id);
    lines.push(`  style ${safeId} fill:#ffa,stroke:#333`);
  }

  return lines.join('\n');
}

// ── Framework Diagram ───────────────────────────────────────────────────────

/**
 * Generate a diagram scoped to nodes that belong to a specific framework (or all frameworks).
 */
export function generateFrameworkDiagram(graph: IntelGraph, framework?: string): string {
  const lines: string[] = ['graph LR'];

  const nodes = framework
    ? graph.allNodes().filter(n => n.framework === framework)
    : graph.allNodes().filter(n => n.framework !== undefined);

  const nodeIdSet = new Set(nodes.map(n => n.id));

  for (const node of nodes) {
    lines.push(`  ${nodeShape(node)}`);
  }

  // Emit edges between framework nodes
  const seenEdges = new Set<string>();
  for (const edge of graph.allEdges()) {
    if (!nodeIdSet.has(edge.source) || !nodeIdSet.has(edge.target)) continue;

    const key = `${edge.source}→${edge.target}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);

    const src = sanitizeId(edge.source);
    const tgt = sanitizeId(edge.target);
    lines.push(`  ${src} --> ${tgt}`);
  }

  return lines.join('\n');
}

// ── Format Query Result ─────────────────────────────────────────────────────

/**
 * Format an ad-hoc set of nodes and edges as a Mermaid subgraph.
 * Matching nodes are highlighted in blue.
 */
export function formatQueryResultAsMermaid(nodes: IntelNode[], edges: IntelEdge[]): string {
  const lines: string[] = ['graph LR'];

  const nodeIdSet = new Set(nodes.map(n => n.id));

  // Emit all provided nodes inside a subgraph
  lines.push('  subgraph results["Query Results"]');
  for (const node of nodes) {
    lines.push(`    ${nodeShape(node)}`);
  }
  lines.push('  end');

  // Emit edges that connect provided nodes
  const seenEdges = new Set<string>();
  for (const edge of edges) {
    if (!nodeIdSet.has(edge.source) || !nodeIdSet.has(edge.target)) continue;

    const key = `${edge.source}→${edge.target}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);

    const src = sanitizeId(edge.source);
    const tgt = sanitizeId(edge.target);
    lines.push(`  ${src} --> ${tgt}`);
  }

  // Highlight all matching nodes in blue
  for (const node of nodes) {
    const safeId = sanitizeId(node.id);
    lines.push(`  style ${safeId} fill:#6af,stroke:#333`);
  }

  return lines.join('\n');
}
