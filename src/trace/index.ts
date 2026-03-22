// src/trace/index.ts — public API barrel export
export { buildIndex } from './indexer.js';
export { traceSymbol, type TraceResult, type UpstreamNode } from './graph.js';
export { analyzeImpact, type ImpactReport } from './impact.js';
export { formatAsciiTree, formatMermaid, formatGraphForAI, formatImpactReport } from './formatter.js';
export { TraceStore } from './store.js';
export { isTreeSitterAvailable } from './parser.js';
