import { basename } from 'node:path';
import type { AnalyzerPlugin, FileAnalysis } from './base.js';
import type { IntelNode, IntelEdge } from '../types.js';

const COMPOSE_FILENAMES = new Set([
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
]);

// FROM image:tag (handles multi-stage: FROM image AS alias)
const _FROM_RE = /^FROM\s+(\S+?)(?:\s+AS\s+\S+)?\s*$/im;
const FROM_ALL_RE = /^FROM\s+(\S+?)(?:\s+AS\s+\S+)?\s*$/gim;

// EXPOSE port
const EXPOSE_RE = /^EXPOSE\s+([\d\s/tcp/udp]+)/gim;

/**
 * Simple indentation-based YAML parser for docker-compose files.
 * Returns a map of service names to their key-value blocks (as raw strings per key).
 */
interface ServiceBlock {
  dependsOn: string[];
  ports: string[];
  volumes: string[];
  image?: string;
}

function parseComposeServices(content: string): Map<string, ServiceBlock> {
  const services = new Map<string, ServiceBlock>();
  const lines = content.split('\n');

  let inServices = false;
  let currentService: string | null = null;
  let currentBlock: ServiceBlock | null = null;
  let inDependsOn = false;
  let inPorts = false;
  let inVolumes = false;

  for (const rawLine of lines) {
    // Skip comments and empty lines for section detection
    const trimmed = rawLine.trimEnd();

    // Check for top-level 'services:' key (0-indent)
    if (/^services\s*:/.test(trimmed)) {
      inServices = true;
      currentService = null;
      currentBlock = null;
      inDependsOn = false;
      inPorts = false;
      inVolumes = false;
      continue;
    }

    if (!inServices) continue;

    // Top-level key (not services, not indent) ends services block
    if (/^\w/.test(trimmed) && !/^services\s*:/.test(trimmed)) {
      if (currentService && currentBlock) {
        services.set(currentService, currentBlock);
      }
      inServices = false;
      continue;
    }

    // Service name: exactly 2-space or 4-space indent with key:
    const serviceMatch = /^ {2}(\w[\w-]*)\s*:/.exec(trimmed);
    if (serviceMatch && !/^\s{4}/.test(trimmed)) {
      // Save previous service
      if (currentService && currentBlock) {
        services.set(currentService, currentBlock);
      }
      currentService = serviceMatch[1]!;
      currentBlock = { dependsOn: [], ports: [], volumes: [] };
      inDependsOn = false;
      inPorts = false;
      inVolumes = false;
      continue;
    }

    if (!currentService || !currentBlock) continue;

    // Keys within a service (4-space indent)
    const keyMatch = /^ {4}(\w[\w_-]*)\s*:(.*)/.exec(trimmed);
    if (keyMatch) {
      const key = keyMatch[1]!.toLowerCase();
      const value = keyMatch[2]!.trim();
      inDependsOn = key === 'depends_on';
      inPorts = key === 'ports';
      inVolumes = key === 'volumes';

      if (key === 'image') {
        currentBlock.image = value;
      } else if (inDependsOn && value) {
        // inline: depends_on: [svcA, svcB]
        const inlineItems = value.replace(/[[\]]/g, '').split(',').map(s => s.trim()).filter(Boolean);
        currentBlock.dependsOn.push(...inlineItems);
      }
      continue;
    }

    // List items under a service key (6-space indent)
    const listItemMatch = /^ {6}-\s+(.+)/.exec(trimmed);
    if (listItemMatch) {
      const item = listItemMatch[1]!.trim().replace(/^['"]|['"]$/g, '');
      if (inDependsOn) currentBlock.dependsOn.push(item);
      else if (inPorts) currentBlock.ports.push(item);
      else if (inVolumes) currentBlock.volumes.push(item);
    }
  }

  // Save last service
  if (currentService && currentBlock) {
    services.set(currentService, currentBlock);
  }

  return services;
}

export class DockerAnalyzer implements AnalyzerPlugin {
  name = 'docker';
  languages = ['docker'];
  extensions = [];
  filenames = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

  analyzeFile(content: string, relPath: string, _rootDir: string): FileAnalysis {
    const nodes: IntelNode[] = [];
    const edges: IntelEdge[] = [];

    const filename = basename(relPath);
    const fileId = `file:${relPath}`;

    // ── File node ────────────────────────────────────────────────────────
    nodes.push({
      id: fileId,
      type: 'file',
      name: relPath,
      filePath: relPath,
      language: 'docker',
      metadata: {},
    });

    if (filename === 'Dockerfile' || filename.startsWith('Dockerfile.')) {
      this.analyzeDockerfile(content, relPath, fileId, nodes, edges);
    } else if (COMPOSE_FILENAMES.has(filename)) {
      this.analyzeCompose(content, relPath, fileId, nodes, edges);
    }

    return { nodes, edges };
  }

  private analyzeDockerfile(
    content: string,
    relPath: string,
    fileId: string,
    nodes: IntelNode[],
    edges: IntelEdge[],
  ): void {
    // FROM instructions → external nodes
    const fromPattern = new RegExp(FROM_ALL_RE.source, FROM_ALL_RE.flags);
    let fromMatch: RegExpExecArray | null;
    const seenImages = new Set<string>();
    while ((fromMatch = fromPattern.exec(content)) !== null) {
      const image = fromMatch[1]!;
      if (image.toUpperCase() === 'SCRATCH') continue;
      if (seenImages.has(image)) continue;
      seenImages.add(image);

      const imageId = `external:${image}`;
      nodes.push({
        id: imageId,
        type: 'external',
        name: image,
        filePath: relPath,
        metadata: { imageType: 'base-image' },
      });
      edges.push({ source: fileId, target: imageId, type: 'depends-on' });
    }

    // EXPOSE instructions → metadata on file node
    const exposedPorts: string[] = [];
    const exposePattern = new RegExp(EXPOSE_RE.source, EXPOSE_RE.flags);
    let exposeMatch: RegExpExecArray | null;
    while ((exposeMatch = exposePattern.exec(content)) !== null) {
      exposedPorts.push(...exposeMatch[1]!.trim().split(/\s+/));
    }

    if (exposedPorts.length > 0) {
      const fileNode = nodes.find(n => n.id === fileId);
      if (fileNode) fileNode.metadata['exposedPorts'] = exposedPorts;
    }
  }

  private analyzeCompose(
    content: string,
    relPath: string,
    fileId: string,
    nodes: IntelNode[],
    edges: IntelEdge[],
  ): void {
    const services = parseComposeServices(content);

    for (const [serviceName, block] of services) {
      const serviceId = `service:${serviceName}`;
      nodes.push({
        id: serviceId,
        type: 'service',
        name: serviceName,
        filePath: relPath,
        framework: 'docker-compose',
        metadata: {
          ports: block.ports,
          volumes: block.volumes,
          ...(block.image ? { image: block.image } : {}),
        },
      });
      edges.push({ source: fileId, target: serviceId, type: 'contains' });
    }

    // depends_on → deploys-with edges (after all service nodes created)
    for (const [serviceName, block] of services) {
      const serviceId = `service:${serviceName}`;
      for (const dep of block.dependsOn) {
        edges.push({
          source: serviceId,
          target: `service:${dep}`,
          type: 'deploys-with',
        });
      }
    }
  }
}
