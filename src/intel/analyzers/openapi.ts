import type { AnalyzerPlugin, FileAnalysis } from './base.js';
import type { IntelNode, IntelEdge } from '../types.js';

/**
 * Simple line-by-line YAML parser for OpenAPI/Swagger files.
 * Detects endpoints from `paths:`, schemas from `components:/definitions:`,
 * and $ref references between schemas.
 */

// HTTP methods recognized in OpenAPI paths blocks
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

// $ref pattern: $ref: '#/components/schemas/Foo' or $ref: '#/definitions/Bar'
const REF_RE = /\$ref\s*:\s*['"]?#\/(?:components\/schemas|definitions)\/(\w+)['"]?/g;

function getIndent(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

function getKey(line: string): string | null {
  const trimmed = line.trim();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) return null;
  return trimmed.slice(0, colonIdx).trim();
}

export class OpenApiAnalyzer implements AnalyzerPlugin {
  name = 'openapi';
  languages = ['openapi'];
  extensions = ['.yaml', '.yml'];

  analyzeFile(content: string, relPath: string, _rootDir: string): FileAnalysis {
    const nodes: IntelNode[] = [];
    const edges: IntelEdge[] = [];

    // ── Guard: only handle OpenAPI/Swagger files ──────────────────────────
    const firstLines = content.split('\n').slice(0, 10).join('\n');
    const isOpenApi = /^openapi\s*:/m.test(firstLines) || /^swagger\s*:/m.test(firstLines);
    if (!isOpenApi) {
      return { nodes: [], edges: [] };
    }

    const fileId = `file:${relPath}`;

    // ── 1. File node ──────────────────────────────────────────────────────
    nodes.push({
      id: fileId,
      type: 'file',
      name: relPath,
      filePath: relPath,
      language: 'openapi',
      metadata: {},
    });

    const lines = content.split('\n');

    // ── 2. Parse paths: → endpoint nodes ─────────────────────────────────
    // State machine: track when we're inside paths: block
    let inPaths = false;
    let inComponents = false;
    let inDefinitions = false;
    let _pathsIndent = -1;
    let currentPath: string | null = null;
    let _currentPathIndent = -1;
    let _componentsIndent = -1;
    let schemasIndent = -1;

    // Schema $ref tracking for depends-on edges
    // We need to track which schema is currently being defined
    let currentSchema: string | null = null;
    let _currentSchemaIndent = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith('#')) continue;

      const indent = getIndent(line);
      const key = getKey(line);
      if (!key) continue;

      // Top-level keys
      if (indent === 0) {
        inPaths = key === 'paths';
        inComponents = key === 'components';
        inDefinitions = key === 'definitions';
        _pathsIndent = inPaths ? 0 : -1;
        _componentsIndent = inComponents ? 0 : -1;
        currentPath = null;
        currentSchema = null;
        schemasIndent = -1;
        if (!inPaths && !inComponents && !inDefinitions) continue;
      }

      // Inside paths block
      if (inPaths) {
        // A path entry: key starts with '/' at indent=2
        if (indent === 2 && key.startsWith('/')) {
          currentPath = key;
          _currentPathIndent = indent;
          continue;
        }

        // HTTP method under a path at indent=4
        if (currentPath && indent === 4 && HTTP_METHODS.has(key.toLowerCase())) {
          const method = key.toUpperCase();
          const routeName = `${method} ${currentPath}`;
          const endpointId = `endpoint:${routeName}`;
          nodes.push({
            id: endpointId,
            type: 'endpoint',
            name: routeName,
            filePath: relPath,
            language: 'openapi',
            metadata: { method, path: currentPath },
          });
          edges.push({ source: fileId, target: endpointId, type: 'contains' });
        }
      }

      // Inside components: block — look for schemas: sub-key
      if (inComponents) {
        if (indent === 2 && key === 'schemas') {
          schemasIndent = indent;
          currentSchema = null;
          continue;
        }

        // Schema name at indent=4 under schemas:
        if (schemasIndent !== -1 && indent === 4) {
          currentSchema = key;
          _currentSchemaIndent = indent;
          const schemaId = `schema:${key}`;
          // Only create node if not already there
          if (!nodes.find(n => n.id === schemaId)) {
            nodes.push({
              id: schemaId,
              type: 'schema',
              name: key,
              filePath: relPath,
              language: 'openapi',
              metadata: {},
            });
            edges.push({ source: fileId, target: schemaId, type: 'contains' });
          }
        }
      }

      // Inside definitions: (Swagger 2.0)
      if (inDefinitions) {
        if (indent === 2) {
          currentSchema = key;
          _currentSchemaIndent = indent;
          const schemaId = `schema:${key}`;
          if (!nodes.find(n => n.id === schemaId)) {
            nodes.push({
              id: schemaId,
              type: 'schema',
              name: key,
              filePath: relPath,
              language: 'openapi',
              metadata: {},
            });
            edges.push({ source: fileId, target: schemaId, type: 'contains' });
          }
        }
      }

      // $ref in any line → depends-on edge from current schema
      if (trimmed.includes('$ref') && currentSchema) {
        const refPattern = new RegExp(REF_RE.source, REF_RE.flags);
        let refMatch: RegExpExecArray | null;
        while ((refMatch = refPattern.exec(trimmed)) !== null) {
          const referencedSchema = refMatch[1]!;
          if (referencedSchema !== currentSchema) {
            edges.push({
              source: `schema:${currentSchema}`,
              target: `schema:${referencedSchema}`,
              type: 'depends-on',
            });
          }
        }
      }
    }

    return { nodes, edges };
  }
}
