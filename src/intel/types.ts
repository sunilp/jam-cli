// src/intel/types.ts

export type NodeType =
  | 'repo' | 'service' | 'module' | 'file'
  | 'class' | 'function' | 'endpoint'
  | 'table' | 'schema' | 'queue' | 'event'
  | 'config' | 'external';

export type EdgeType =
  | 'imports' | 'calls'
  | 'reads' | 'writes'
  | 'publishes' | 'subscribes'
  | 'exposes' | 'consumes'
  | 'contains' | 'configures'
  | 'deploys-with' | 'depends-on';

export type EnrichDepth = 'shallow' | 'deep' | 'none';

export interface IntelNode {
  id: string;
  type: NodeType;
  name: string;
  filePath?: string;
  line?: number;
  language?: string;
  framework?: string;
  metadata: Record<string, unknown>;
}

export interface IntelEdge {
  source: string;
  target: string;
  type: EdgeType;
  metadata?: Record<string, unknown>;
}

export interface SemanticMetadata {
  nodeId: string;
  purpose?: string;
  pattern?: string;
  domain?: string;
  risk?: 'low' | 'medium' | 'high';
  summary?: string;
  semanticEdges?: Array<{ target: string; type: EdgeType; reason: string }>;
  enrichedAt?: string;
  depth: EnrichDepth;
}

export interface SerializedGraph {
  version: 1;
  scannedAt: string;
  rootDir: string;
  nodeCount: number;
  edgeCount: number;
  nodes: IntelNode[];
  edges: IntelEdge[];
  frameworks: string[];
  languages: string[];
  mtimes: Record<string, number>;
}

export interface SerializedEnrichment {
  version: 1;
  enrichedAt: string;
  depth: EnrichDepth;
  tokensUsed: number;
  entries: SemanticMetadata[];
}

export interface IntelStats {
  nodeCount: number;
  edgeCount: number;
  fileCount: number;
  languages: string[];
  frameworks: string[];
  enrichmentProgress: number;
  tokensUsed: number;
  lastScannedAt?: string;
}
