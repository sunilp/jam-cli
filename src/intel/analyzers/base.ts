import type { IntelNode, IntelEdge } from '../types.js';

export interface FileAnalysis {
  nodes: IntelNode[];
  edges: IntelEdge[];
}

export interface ProjectAnalysisResult {
  nodes: IntelNode[];
  edges: IntelEdge[];
  frameworks: string[];
}

export interface AnalyzerPlugin {
  name: string;
  languages: string[];
  extensions: string[];
  /** Exact filenames to match (e.g., 'Dockerfile', 'docker-compose.yml') */
  filenames?: string[];
  /** Analyze a single file. rootDir provided for import resolution. */
  analyzeFile(content: string, relPath: string, rootDir: string): FileAnalysis;
  /** Optional: cross-file analysis after all files scanned */
  analyzeProject?(allNodes: IntelNode[], allEdges: IntelEdge[], rootDir: string): ProjectAnalysisResult;
}
