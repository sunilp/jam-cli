// src/intel/query.ts

import type { ProviderAdapter, ToolDefinition, ToolCall } from '../providers/base.js';
import type { IntelNode, IntelEdge, SemanticMetadata, NodeType } from './types.js';
import type { IntelGraph } from './graph.js';
import { formatQueryResultAsMermaid } from './mermaid.js';
import { logger } from '../utils/logger.js';

export interface QueryResult {
  nodes: IntelNode[];
  edges: IntelEdge[];
  explanation?: string;
  mermaid?: string;
}

export interface QueryOptions {
  noAi?: boolean;
  mermaid?: boolean;
  type?: NodeType;
}

// ── Graph operation tools ─────────────────────────────────────────────────────

const GRAPH_TOOLS: ToolDefinition[] = [
  {
    name: 'findNode',
    description: 'Search for nodes by keyword in name or file path.',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Keyword to search for' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'getNeighbors',
    description: 'Get neighboring nodes of a given node.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The node ID to find neighbors for' },
        direction: {
          type: 'string',
          enum: ['outgoing', 'incoming', 'both'],
          description: 'Direction of edges to follow',
        },
      },
      required: ['nodeId', 'direction'],
    },
  },
  {
    name: 'filterByType',
    description: 'Get all nodes of a specific type.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
            'repo', 'service', 'module', 'file',
            'class', 'function', 'endpoint',
            'table', 'schema', 'queue', 'event',
            'config', 'external',
          ],
          description: 'The node type to filter by',
        },
      },
      required: ['type'],
    },
  },
  {
    name: 'getImpactSubgraph',
    description: 'Get all nodes that depend on (are impacted by changes to) a given node.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'The node ID to find dependents for' },
      },
      required: ['nodeId'],
    },
  },
];

// ── Tool execution ────────────────────────────────────────────────────────────

function executeToolCall(toolCall: ToolCall, graph: IntelGraph): IntelNode[] {
  const args = toolCall.arguments;

  switch (toolCall.name) {
    case 'findNode': {
      const keyword = typeof args['keyword'] === 'string' ? args['keyword'] : '';
      return graph.search(keyword);
    }
    case 'getNeighbors': {
      const nodeId = typeof args['nodeId'] === 'string' ? args['nodeId'] : '';
      const direction = args['direction'];
      const dir =
        direction === 'outgoing' || direction === 'incoming' || direction === 'both'
          ? direction
          : 'both';
      return graph.getNeighbors(nodeId, dir);
    }
    case 'filterByType': {
      const type = typeof args['type'] === 'string' ? (args['type'] as NodeType) : 'file';
      return graph.filterByType(type);
    }
    case 'getImpactSubgraph': {
      const nodeId = typeof args['nodeId'] === 'string' ? args['nodeId'] : '';
      return graph.getImpactSubgraph(nodeId);
    }
    default:
      logger.warn(`[query] Unknown tool call: ${toolCall.name}`);
      return [];
  }
}

// ── Offline (keyword) query ───────────────────────────────────────────────────

function offlineQuery(
  queryText: string,
  graph: IntelGraph,
  options: QueryOptions,
): QueryResult {
  let nodes = graph.search(queryText);

  if (options.type != null) {
    nodes = nodes.filter(n => n.type === options.type);
  }

  // Collect edges between the matched nodes
  const nodeIdSet = new Set(nodes.map(n => n.id));
  const edges = graph
    .allEdges()
    .filter(e => nodeIdSet.has(e.source) && nodeIdSet.has(e.target));

  const result: QueryResult = { nodes, edges };

  if (options.mermaid) {
    result.mermaid = formatQueryResultAsMermaid(nodes, edges);
  }

  return result;
}

// ── Main query function ───────────────────────────────────────────────────────

export async function query(
  queryText: string,
  graph: IntelGraph,
  enrichment: SemanticMetadata[],
  provider: ProviderAdapter | null,
  options: QueryOptions,
): Promise<QueryResult> {
  // Determine if NL/AI mode is available
  const canUseAi =
    !options.noAi &&
    provider != null &&
    provider.chatWithTools != null;

  if (!canUseAi) {
    return offlineQuery(queryText, graph, options);
  }

  // NL mode: use tool calling
  try {
    const systemPrompt = [
      'You are a codebase architecture assistant.',
      'Use the provided tools to answer the user\'s query about the codebase graph.',
      'Call one or more tools as needed, then summarize the results.',
      enrichment.length > 0
        ? `There are ${enrichment.length} enriched nodes with semantic metadata available.`
        : null,
    ]
      .filter(Boolean)
      .join('\n');

    const response = await provider.chatWithTools!(
      [{ role: 'user', content: queryText }],
      GRAPH_TOOLS,
      { systemPrompt },
    );

    const collectedNodes: IntelNode[] = [];
    const seenNodeIds = new Set<string>();

    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const toolCall of response.toolCalls) {
        const toolNodes = executeToolCall(toolCall, graph);
        for (const node of toolNodes) {
          if (!seenNodeIds.has(node.id)) {
            seenNodeIds.add(node.id);
            collectedNodes.push(node);
          }
        }
      }
    }

    // If no tool calls were made, fall back to offline keyword search
    if (collectedNodes.length === 0 && (!response.toolCalls || response.toolCalls.length === 0)) {
      logger.info('[query] No tool calls returned by provider, falling back to offline search');
      return offlineQuery(queryText, graph, options);
    }

    // Collect edges between matched nodes
    const nodeIdSet = new Set(collectedNodes.map(n => n.id));
    const edges = graph
      .allEdges()
      .filter(e => nodeIdSet.has(e.source) && nodeIdSet.has(e.target));

    const result: QueryResult = {
      nodes: collectedNodes,
      edges,
      explanation: response.content ?? undefined,
    };

    if (options.mermaid) {
      result.mermaid = formatQueryResultAsMermaid(collectedNodes, edges);
    }

    return result;
  } catch (err) {
    logger.warn(`[query] Tool-calling query failed, falling back to offline: ${String(err)}`);
    return offlineQuery(queryText, graph, options);
  }
}
