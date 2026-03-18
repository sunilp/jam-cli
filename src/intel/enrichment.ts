// src/intel/enrichment.ts

import type { ProviderAdapter } from '../providers/base.js';
import type { IntelNode, SemanticMetadata, EnrichDepth } from './types.js';
import type { IntelGraph } from './graph.js';
import { logger } from '../utils/logger.js';

export interface EnrichmentOptions {
  depth: EnrichDepth;
  maxTokenBudget: number;
  onProgress?: (progress: number, nodeId: string) => void;
}

// Approximate chars-per-token ratio for budget estimation
const CHARS_PER_TOKEN = 4;

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export class EnrichmentEngine {
  constructor(private provider: ProviderAdapter) {}

  /**
   * Compute priority order: sort by (inDegree + outDegree + churnCount) descending.
   */
  prioritize(graph: IntelGraph, churnData?: Map<string, number>): string[] {
    const nodes = graph.allNodes();
    const scored = nodes.map(node => {
      const outDegree = graph.getEdgesFrom(node.id).length;
      const inDegree = graph.getEdgesTo(node.id).length;
      const churn = churnData?.get(node.id) ?? 0;
      return { id: node.id, score: inDegree + outDegree + churn };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.id);
  }

  /**
   * Build prompt for enriching a node.
   */
  buildPrompt(
    node: IntelNode,
    neighbors: IntelNode[],
    depth: EnrichDepth,
  ): { system: string; user: string } {
    const fieldsForDepth =
      depth === 'shallow'
        ? '{ "purpose": string, "summary": string }'
        : '{ "purpose": string, "summary": string, "pattern": string, "domain": string, "risk": "low"|"medium"|"high", "semanticEdges": [{ "target": string, "type": string, "reason": string }] }';

    const system = [
      'You are a software architecture analyst.',
      'Analyze the provided code node and return a JSON object with exactly these fields:',
      fieldsForDepth,
      'Return ONLY valid JSON. No explanation, no markdown, no code fences.',
    ].join('\n');

    const neighborList =
      neighbors.length > 0
        ? neighbors.map(n => `  - ${n.type} "${n.name}"${n.filePath ? ` (${n.filePath})` : ''}`).join('\n')
        : '  (none)';

    const user = [
      `Node type: ${node.type}`,
      `Name: ${node.name}`,
      node.filePath ? `File path: ${node.filePath}` : null,
      node.language ? `Language: ${node.language}` : null,
      node.framework ? `Framework: ${node.framework}` : null,
      `Neighbors:\n${neighborList}`,
      depth === 'shallow'
        ? 'Provide a brief purpose and summary for this node.'
        : 'Provide a thorough analysis including architectural pattern, domain, risk level, and any semantic relationships not captured in the graph edges.',
    ]
      .filter(Boolean)
      .join('\n');

    return { system, user };
  }

  /**
   * Parse LLM JSON response into SemanticMetadata.
   * Handles malformed JSON gracefully by returning a minimal metadata object.
   */
  parseResponse(response: string, nodeId: string, depth: EnrichDepth): SemanticMetadata {
    // Strip markdown code fences if present
    const cleaned = response
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
      logger.warn(`[enrichment] Failed to parse LLM response for node "${nodeId}", using empty metadata`);
      return {
        nodeId,
        depth,
        enrichedAt: new Date().toISOString(),
      };
    }

    const meta: SemanticMetadata = {
      nodeId,
      depth,
      enrichedAt: new Date().toISOString(),
    };

    if (typeof parsed['purpose'] === 'string') meta.purpose = parsed['purpose'];
    if (typeof parsed['summary'] === 'string') meta.summary = parsed['summary'];

    if (depth === 'deep') {
      if (typeof parsed['pattern'] === 'string') meta.pattern = parsed['pattern'];
      if (typeof parsed['domain'] === 'string') meta.domain = parsed['domain'];
      const risk = parsed['risk'];
      if (risk === 'low' || risk === 'medium' || risk === 'high') meta.risk = risk;
      if (Array.isArray(parsed['semanticEdges'])) {
        meta.semanticEdges = (parsed['semanticEdges'] as unknown[])
          .filter(
            (e): e is { target: string; type: string; reason: string } =>
              typeof e === 'object' &&
              e !== null &&
              typeof (e as Record<string, unknown>)['target'] === 'string' &&
              typeof (e as Record<string, unknown>)['type'] === 'string' &&
              typeof (e as Record<string, unknown>)['reason'] === 'string',
          )
          .map(e => ({
            target: e.target,
            // The type must be cast — we trust the LLM to produce valid EdgeType strings
            type: e.type as SemanticMetadata['semanticEdges'] extends Array<infer T>
              ? T extends { type: infer U }
                ? U
                : never
              : never,
            reason: e.reason,
          }));
      }
    }

    return meta;
  }

  /**
   * Enrich a single node via streamCompletion.
   */
  async enrichNode(node: IntelNode, graph: IntelGraph, depth: EnrichDepth): Promise<SemanticMetadata> {
    const neighbors = graph.getNeighbors(node.id, 'both');
    const { system, user } = this.buildPrompt(node, neighbors, depth);

    let fullResponse = '';
    const stream = this.provider.streamCompletion({
      messages: [{ role: 'user', content: user }],
      systemPrompt: system,
      temperature: 0,
    });

    for await (const chunk of stream) {
      fullResponse += chunk.delta;
    }

    return this.parseResponse(fullResponse, node.id, depth);
  }

  /**
   * Enrich all nodes progressively, respecting budget.
   */
  async enrichAll(graph: IntelGraph, options: EnrichmentOptions): Promise<SemanticMetadata[]> {
    const { depth, maxTokenBudget, onProgress } = options;

    if (depth === 'none') return [];

    const orderedIds = this.prioritize(graph);
    const results: SemanticMetadata[] = [];
    let tokensUsed = 0;
    let processed = 0;
    const total = orderedIds.length;

    for (const nodeId of orderedIds) {
      const node = graph.getNode(nodeId);
      if (!node) continue;

      // Estimate tokens for this node's prompt
      const neighbors = graph.getNeighbors(nodeId, 'both');
      const { system, user } = this.buildPrompt(node, neighbors, depth);
      const promptTokens = estimateTokenCount(system + user);
      const outputTokens = depth === 'shallow' ? 100 : 300;
      const estimatedCost = promptTokens + outputTokens;

      if (tokensUsed + estimatedCost > maxTokenBudget) {
        logger.info(
          `[enrichment] Budget limit reached at ${tokensUsed}/${maxTokenBudget} tokens, stopping after ${processed}/${total} nodes`,
        );
        break;
      }

      try {
        const meta = await this.enrichNode(node, graph, depth);
        results.push(meta);
        tokensUsed += estimatedCost;
      } catch (err) {
        logger.warn(`[enrichment] Failed to enrich node "${nodeId}": ${String(err)}`);
      }

      processed++;
      if (onProgress) {
        onProgress(total > 0 ? processed / total : 1, nodeId);
      }
    }

    return results;
  }
}
