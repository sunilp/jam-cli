// src/intel/index.ts

export { IntelGraph } from './graph.js';
export { Scanner } from './scanner.js';
export { EnrichmentEngine } from './enrichment.js';
export type { EnrichmentOptions } from './enrichment.js';
export { query } from './query.js';
export type { QueryResult, QueryOptions } from './query.js';
export { saveGraph, loadGraph, saveEnrichment, loadEnrichment, saveMermaid, checkGitignore } from './storage.js';
export {
  generateArchitectureDiagram,
  generateDepsDiagram,
  generateFlowDiagram,
  generateImpactDiagram,
  generateFrameworkDiagram,
  formatQueryResultAsMermaid,
} from './mermaid.js';
export { generateViewerHtml, openInBrowser } from './viewer.js';
export type {
  IntelNode,
  IntelEdge,
  SemanticMetadata,
  IntelStats,
  EnrichDepth,
  NodeType,
  EdgeType,
  SerializedGraph,
  SerializedEnrichment,
} from './types.js';
export type { AnalyzerPlugin, FileAnalysis } from './analyzers/base.js';
export { AnalyzerRegistry, createDefaultRegistry } from './analyzers/registry.js';
