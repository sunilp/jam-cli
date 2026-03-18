// src/intel/graph.ts

import type {
  IntelNode,
  IntelEdge,
  NodeType,
  EnrichDepth,
  SerializedGraph,
  IntelStats,
} from './types.js';

export class IntelGraph {
  private _nodes: Map<string, IntelNode> = new Map();
  private _edges: IntelEdge[] = [];
  // Maps nodeId -> Set of edge indices for outgoing edges
  private _outgoing: Map<string, Set<number>> = new Map();
  // Maps nodeId -> Set of edge indices for incoming edges
  private _incoming: Map<string, Set<number>> = new Map();

  // Public metadata fields used in serialization
  frameworks: string[] = [];
  languages: string[] = [];
  mtimes: Record<string, number> = {};

  // ── Node operations ────────────────────────────────────────────────────────

  addNode(node: IntelNode): void {
    this._nodes.set(node.id, node);
    if (!this._outgoing.has(node.id)) this._outgoing.set(node.id, new Set());
    if (!this._incoming.has(node.id)) this._incoming.set(node.id, new Set());
  }

  getNode(id: string): IntelNode | null {
    return this._nodes.get(id) ?? null;
  }

  removeNode(id: string): void {
    if (!this._nodes.has(id)) return;
    this._nodes.delete(id);

    // Collect indices of edges that involve this node
    const toRemove = new Set<number>();
    for (let i = 0; i < this._edges.length; i++) {
      const e = this._edges[i];
      if (e.source === id || e.target === id) {
        toRemove.add(i);
      }
    }

    // Remove edges (rebuild array without removed indices)
    const newEdges: IntelEdge[] = [];
    const indexRemap = new Map<number, number>();
    for (let i = 0; i < this._edges.length; i++) {
      if (!toRemove.has(i)) {
        indexRemap.set(i, newEdges.length);
        newEdges.push(this._edges[i]);
      }
    }
    this._edges = newEdges;

    // Rebuild adjacency index maps
    this._outgoing.delete(id);
    this._incoming.delete(id);

    for (const [nodeId, oldSet] of this._outgoing) {
      const newSet = new Set<number>();
      for (const idx of oldSet) {
        if (indexRemap.has(idx)) newSet.add(indexRemap.get(idx)!);
      }
      this._outgoing.set(nodeId, newSet);
    }

    for (const [nodeId, oldSet] of this._incoming) {
      const newSet = new Set<number>();
      for (const idx of oldSet) {
        if (indexRemap.has(idx)) newSet.add(indexRemap.get(idx)!);
      }
      this._incoming.set(nodeId, newSet);
    }
  }

  // ── Edge operations ────────────────────────────────────────────────────────

  addEdge(edge: IntelEdge): void {
    const idx = this._edges.length;
    this._edges.push(edge);

    // Ensure adjacency sets exist for both endpoints
    if (!this._outgoing.has(edge.source)) this._outgoing.set(edge.source, new Set());
    if (!this._incoming.has(edge.source)) this._incoming.set(edge.source, new Set());
    if (!this._outgoing.has(edge.target)) this._outgoing.set(edge.target, new Set());
    if (!this._incoming.has(edge.target)) this._incoming.set(edge.target, new Set());

    this._outgoing.get(edge.source)!.add(idx);
    this._incoming.get(edge.target)!.add(idx);
  }

  getEdgesFrom(nodeId: string): IntelEdge[] {
    const indices = this._outgoing.get(nodeId);
    if (!indices) return [];
    return Array.from(indices).map(i => this._edges[i]);
  }

  getEdgesTo(nodeId: string): IntelEdge[] {
    const indices = this._incoming.get(nodeId);
    if (!indices) return [];
    return Array.from(indices).map(i => this._edges[i]);
  }

  // ── Graph traversal ────────────────────────────────────────────────────────

  getNeighbors(nodeId: string, direction: 'outgoing' | 'incoming' | 'both'): IntelNode[] {
    const result: IntelNode[] = [];
    const seen = new Set<string>();

    if (direction === 'outgoing' || direction === 'both') {
      for (const edge of this.getEdgesFrom(nodeId)) {
        if (!seen.has(edge.target)) {
          seen.add(edge.target);
          const node = this._nodes.get(edge.target);
          if (node) result.push(node);
        }
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      for (const edge of this.getEdgesTo(nodeId)) {
        if (!seen.has(edge.source)) {
          seen.add(edge.source);
          const node = this._nodes.get(edge.source);
          if (node) result.push(node);
        }
      }
    }

    return result;
  }

  /**
   * BFS shortest path from fromId to toId following outgoing edges.
   * Returns the path as an array of nodes, or null if no path exists.
   */
  findPath(fromId: string, toId: string): IntelNode[] | null {
    if (!this._nodes.has(fromId) || !this._nodes.has(toId)) return null;
    if (fromId === toId) {
      const node = this._nodes.get(fromId)!;
      return [node];
    }

    const visited = new Set<string>();
    // Each queue entry: [currentId, pathSoFar]
    const queue: Array<[string, string[]]> = [[fromId, [fromId]]];
    visited.add(fromId);

    while (queue.length > 0) {
      const [current, path] = queue.shift()!;
      for (const edge of this.getEdgesFrom(current)) {
        const next = edge.target;
        if (visited.has(next)) continue;
        const newPath = [...path, next];
        if (next === toId) {
          return newPath.map(id => this._nodes.get(id)!);
        }
        visited.add(next);
        queue.push([next, newPath]);
      }
    }

    return null;
  }

  /**
   * Reverse BFS from nodeId following incoming edges.
   * Returns all nodes that (transitively) depend on the given node.
   */
  getImpactSubgraph(nodeId: string): IntelNode[] {
    const visited = new Set<string>();
    const queue: string[] = [nodeId];
    visited.add(nodeId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of this.getEdgesTo(current)) {
        const prev = edge.source;
        if (!visited.has(prev)) {
          visited.add(prev);
          queue.push(prev);
        }
      }
    }

    // Exclude the starting node itself, return all upstream dependents
    visited.delete(nodeId);
    return Array.from(visited)
      .map(id => this._nodes.get(id))
      .filter((n): n is IntelNode => n !== undefined);
  }

  filterByType(type: NodeType): IntelNode[] {
    return Array.from(this._nodes.values()).filter(n => n.type === type);
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  search(keyword: string): IntelNode[] {
    const lower = keyword.toLowerCase();
    return Array.from(this._nodes.values()).filter(n => {
      return (
        n.name.toLowerCase().includes(lower) ||
        (n.filePath !== undefined && n.filePath.toLowerCase().includes(lower))
      );
    });
  }

  // ── Bulk accessors ─────────────────────────────────────────────────────────

  allNodes(): IntelNode[] {
    return Array.from(this._nodes.values());
  }

  allEdges(): IntelEdge[] {
    return [...this._edges];
  }

  // ── Properties ────────────────────────────────────────────────────────────

  get nodeCount(): number {
    return this._nodes.size;
  }

  get edgeCount(): number {
    return this._edges.length;
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  getStats(): IntelStats {
    const fileCount = this.filterByType('file').length;
    return {
      nodeCount: this.nodeCount,
      edgeCount: this.edgeCount,
      fileCount,
      languages: [...this.languages],
      frameworks: [...this.frameworks],
      enrichmentProgress: 0,
      tokensUsed: 0,
    };
  }

  // ── Token estimation ───────────────────────────────────────────────────────

  estimateTokens(depth: EnrichDepth): number {
    if (depth === 'none') return 0;
    if (depth === 'shallow') return this.nodeCount * 200;
    // deep
    return this.nodeCount * 600;
  }

  // ── Serialization ──────────────────────────────────────────────────────────

  serialize(rootDir: string): SerializedGraph {
    return {
      version: 1,
      scannedAt: new Date().toISOString(),
      rootDir,
      nodeCount: this.nodeCount,
      edgeCount: this.edgeCount,
      nodes: this.allNodes(),
      edges: this.allEdges(),
      frameworks: [...this.frameworks],
      languages: [...this.languages],
      mtimes: { ...this.mtimes },
    };
  }

  static deserialize(data: SerializedGraph): IntelGraph {
    const g = new IntelGraph();
    g.frameworks = data.frameworks ?? [];
    g.languages = data.languages ?? [];
    g.mtimes = data.mtimes ?? {};
    for (const node of data.nodes) {
      g.addNode(node);
    }
    for (const edge of data.edges) {
      g.addEdge(edge);
    }
    return g;
  }
}
