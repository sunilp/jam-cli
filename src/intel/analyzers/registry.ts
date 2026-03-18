import { basename } from 'node:path';
import type { AnalyzerPlugin } from './base.js';
import { TypeScriptAnalyzer } from './typescript.js';
import { PythonAnalyzer } from './python.js';
import { CobolAnalyzer } from './cobol.js';
import { SqlAnalyzer } from './sql.js';
import { DockerAnalyzer } from './docker.js';
import { OpenApiAnalyzer } from './openapi.js';

export class AnalyzerRegistry {
  private plugins: AnalyzerPlugin[] = [];
  private extMap = new Map<string, AnalyzerPlugin>();
  private filenameMap = new Map<string, AnalyzerPlugin>();

  register(plugin: AnalyzerPlugin): void {
    this.plugins.push(plugin);
    for (const ext of plugin.extensions) {
      this.extMap.set(ext, plugin);
    }
    for (const name of plugin.filenames ?? []) {
      this.filenameMap.set(name, plugin);
    }
  }

  getForFile(filePath: string): AnalyzerPlugin | null {
    const name = basename(filePath);
    if (this.filenameMap.has(name)) return this.filenameMap.get(name)!;
    const dotIdx = name.lastIndexOf('.');
    if (dotIdx >= 0) {
      const ext = name.slice(dotIdx);
      if (this.extMap.has(ext)) return this.extMap.get(ext)!;
    }
    return null;
  }

  getAll(): AnalyzerPlugin[] { return [...this.plugins]; }
}

export function createDefaultRegistry(): AnalyzerRegistry {
  const registry = new AnalyzerRegistry();
  registry.register(new TypeScriptAnalyzer());
  registry.register(new PythonAnalyzer());
  registry.register(new CobolAnalyzer());
  registry.register(new SqlAnalyzer());
  registry.register(new DockerAnalyzer());
  registry.register(new OpenApiAnalyzer());
  return registry;
}
