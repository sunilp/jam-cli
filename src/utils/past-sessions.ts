/**
 * Past session search — find relevant Q&A from previous sessions.
 *
 * Uses a simple TF-IDF-like keyword overlap to find past conversations
 * that are relevant to the current question.  No vector embeddings needed —
 * this is a pragmatic approach for local-first CLI tools.
 */

import { listSessions, getSession } from '../storage/history.js';
import type { SessionDetail } from '../storage/history.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PastExchange {
  /** The user's question from the past session. */
  question: string;
  /** The assistant's answer from the past session. */
  answer: string;
  /** The session name / id. */
  sessionId: string;
  /** Relevance score (0–1). */
  score: number;
}

// ── Tokenization / scoring ────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'about',
  'this', 'that', 'and', 'or', 'but', 'not', 'so', 'if', 'then',
  'than', 'too', 'very', 'just', 'how', 'where', 'what', 'which',
  'who', 'when', 'why', 'all', 'each', 'every', 'some', 'any',
  'its', 'it', 'you', 'your', 'we', 'our', 'they', 'their',
  'i', 'me', 'my', 'change', 'adding', 'using', 'make', 'use',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_.-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Compute a simple keyword overlap score between two texts.
 * Returns 0–1 where 1 means perfect overlap.
 */
function keywordOverlap(queryTokens: string[], targetTokens: string[]): number {
  if (queryTokens.length === 0 || targetTokens.length === 0) return 0;

  const targetSet = new Set(targetTokens);
  const matches = queryTokens.filter(t => targetSet.has(t));

  // Jaccard-like: overlap / union
  const union = new Set([...queryTokens, ...targetTokens]);
  return matches.length / union.size;
}

// ── Main search ───────────────────────────────────────────────────────────────

/**
 * Search past sessions for Q&A exchanges relevant to the current question.
 *
 * @param question          The user's current question.
 * @param workspaceRoot     Current workspace root (to scope sessions).
 * @param maxResults        Maximum exchanges to return.
 * @param minScore          Minimum relevance score to include.
 */
export async function searchPastSessions(
  question: string,
  workspaceRoot: string,
  maxResults: number = 3,
  minScore: number = 0.15,
): Promise<PastExchange[]> {
  const queryTokens = tokenize(question);
  if (queryTokens.length === 0) return [];

  let sessions;
  try {
    sessions = await listSessions();
  } catch {
    return [];
  }

  // Only look at sessions from the same workspace, limit to recent 20
  const relevantSessions = sessions
    .filter(s => s.workspaceRoot === workspaceRoot)
    .slice(0, 20);

  const candidates: PastExchange[] = [];

  for (const sessionMeta of relevantSessions) {
    let session: SessionDetail | null;
    try {
      session = await getSession(sessionMeta.id);
    } catch {
      continue;
    }
    if (!session?.messages) continue;

    // Extract user→assistant pairs
    for (let i = 0; i < session.messages.length - 1; i++) {
      const msg = session.messages[i]!;
      const next = session.messages[i + 1];

      if (msg.role === 'user' && next?.role === 'assistant') {
        // Skip tool-result injections and system messages
        if (msg.content.startsWith('[Tool result:') || msg.content.startsWith('[SYSTEM')) continue;
        if (msg.content.startsWith('[WORKING MEMORY') || msg.content.startsWith('[CONTEXT')) continue;

        const questionTokens = tokenize(msg.content);
        const score = keywordOverlap(queryTokens, questionTokens);

        if (score >= minScore) {
          candidates.push({
            question: msg.content.slice(0, 500),
            answer: next.content.slice(0, 1500), // Cap size
            sessionId: session.id,
            score,
          });
        }
      }
    }
  }

  // Sort by score descending, take top N
  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

/**
 * Format past exchanges as context to inject into the system prompt or messages.
 */
export function formatPastExchanges(exchanges: PastExchange[]): string {
  if (exchanges.length === 0) return '';

  const parts = [
    '## Relevant Past Conversations',
    '',
    'These previous Q&A exchanges from this project may provide useful context:',
    '',
  ];

  for (const ex of exchanges) {
    parts.push(`**Q:** ${ex.question.slice(0, 200)}`);
    parts.push(`**A:** ${ex.answer.slice(0, 500)}`);
    parts.push('');
  }

  parts.push('---');
  parts.push('Use the above as background context, but always verify by reading current code.');
  parts.push('');

  return parts.join('\n');
}
