/**
 * Shared types for codebase analysis (used by jam deps, jam diagram, etc.).
 */

export type Graph = Map<string, Set<string>>;

export interface ModuleInfo {
  name: string;
  directory: string;
  fileCount: number;
  files: string[];
  exportedSymbols: string[];
}

export interface SymbolInfo {
  name: string;
  kind: 'class' | 'interface' | 'type' | 'function' | 'enum';
  file: string;
  module: string;
  exported: boolean;
}

export interface ProjectAnalysis {
  name: string;
  rootDir: string;
  entryPoints: string[];
  modules: ModuleInfo[];
  interModuleDeps: Array<{ from: string; to: string; weight: number }>;
  cycles: string[][];
  hotspots: Array<{ file: string; importers: number }>;
  symbols: SymbolInfo[];
  fileCount: number;
  importCount: number;
}
