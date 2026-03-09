/**
 * Jira REST API client.
 * Works with both Jira Cloud and Jira Server/Data Center (on-prem).
 * Uses REST API v2 which is supported across all versions.
 */

import { JamError } from '../utils/errors.js';
import type { JiraConfig } from '../config/schema.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  type: string;
  priority: string;
  assignee: string | null;
  description: string | null;
  labels: string[];
  components: string[];
  created: string;
  updated: string;
  subtasks: Array<{ key: string; summary: string; status: string }>;
  comments: Array<{ author: string; body: string; created: string }>;
  /** Parent epic or parent issue key, if any */
  parent: string | null;
}

export interface JiraIssueSummary {
  key: string;
  summary: string;
  status: string;
  type: string;
  priority: string;
  updated: string;
}

interface JiraSearchResponse {
  issues: Array<{
    key: string;
    fields: {
      summary: string;
      status: { name: string };
      issuetype: { name: string };
      priority: { name: string };
      assignee: { displayName: string; emailAddress?: string } | null;
      updated: string;
    };
  }>;
  total: number;
}

interface JiraIssueResponse {
  key: string;
  fields: {
    summary: string;
    description: string | null;
    status: { name: string };
    issuetype: { name: string };
    priority: { name: string };
    assignee: { displayName: string } | null;
    labels: string[];
    components: Array<{ name: string }>;
    created: string;
    updated: string;
    subtasks: Array<{
      key: string;
      fields: { summary: string; status: { name: string } };
    }>;
    comment: {
      comments: Array<{
        author: { displayName: string };
        body: string;
        created: string;
      }>;
    };
    parent?: { key: string };
  };
}

// ── Client ───────────────────────────────────────────────────────────────────

export class JiraClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(config: NonNullable<JiraConfig>) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    const token = config.apiToken ?? process.env['JIRA_API_TOKEN'];
    if (!token) {
      throw new JamError(
        'No Jira API token found. Set apiToken in your .jamrc jira config or export JIRA_API_TOKEN.',
        'PROVIDER_AUTH_FAILED',
        { retryable: false }
      );
    }
    // Cloud uses email:token as basic auth, Server uses token as Bearer or basic auth
    // Basic auth with email:token works for both in practice
    this.authHeader = 'Basic ' + Buffer.from(`${config.email}:${token}`).toString('base64');
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/rest/api/2${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.authHeader,
          ...options.headers,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new JamError(
        `Cannot reach Jira at ${this.baseUrl}. Check your network and Jira URL.\n` +
        'Run `jam doctor` for diagnostics.',
        'PROVIDER_UNAVAILABLE',
        { retryable: false, cause: err }
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new JamError(
        'Jira authentication failed. Check your email and API token in .jamrc.',
        'PROVIDER_AUTH_FAILED',
        { retryable: false, statusCode: response.status }
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new JamError(
        `Jira returned HTTP ${response.status}: ${text.slice(0, 200)}`,
        'PROVIDER_STREAM_ERROR',
        { retryable: false, statusCode: response.status }
      );
    }

    return (await response.json()) as T;
  }

  /**
   * Fetch issues assigned to the current user.
   * Supports additional JQL filtering.
   */
  async getMyIssues(options: {
    status?: string[];
    maxResults?: number;
    jql?: string;
  } = {}): Promise<JiraIssueSummary[]> {
    const conditions: string[] = ['assignee = currentUser()'];

    if (options.status && options.status.length > 0) {
      const statuses = options.status.map((s) => `"${s}"`).join(', ');
      conditions.push(`status in (${statuses})`);
    } else {
      // Default: exclude Done/Closed
      conditions.push('status not in (Done, Closed, Resolved)');
    }

    if (options.jql) {
      conditions.push(`(${options.jql})`);
    }

    const jql = conditions.join(' AND ') + ' ORDER BY updated DESC';
    const maxResults = options.maxResults ?? 20;

    const data = await this.request<JiraSearchResponse>(
      `/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=summary,status,issuetype,priority,assignee,updated`
    );

    return data.issues.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      type: issue.fields.issuetype.name,
      priority: issue.fields.priority.name,
      updated: issue.fields.updated,
    }));
  }

  /**
   * Fetch full details for a specific issue.
   */
  async getIssue(issueKey: string): Promise<JiraIssue> {
    const data = await this.request<JiraIssueResponse>(
      `/issue/${encodeURIComponent(issueKey)}?expand=renderedFields`
    );

    const f = data.fields;
    return {
      key: data.key,
      summary: f.summary,
      status: f.status.name,
      type: f.issuetype.name,
      priority: f.priority.name,
      assignee: f.assignee?.displayName ?? null,
      description: f.description,
      labels: f.labels ?? [],
      components: (f.components ?? []).map((c) => c.name),
      created: f.created,
      updated: f.updated,
      subtasks: (f.subtasks ?? []).map((s) => ({
        key: s.key,
        summary: s.fields.summary,
        status: s.fields.status.name,
      })),
      comments: (f.comment?.comments ?? []).slice(-5).map((c) => ({
        author: c.author.displayName,
        body: c.body,
        created: c.created,
      })),
      parent: f.parent?.key ?? null,
    };
  }

  /**
   * Test connectivity and auth.
   */
  async validateConnection(): Promise<string> {
    const data = await this.request<{ displayName: string; emailAddress?: string }>('/myself');
    return data.displayName;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a git branch name from a Jira issue.
 */
export function buildBranchName(
  issue: JiraIssueSummary | JiraIssue,
  template?: string,
): string {
  const tpl = template ?? '{key}-{summary}';

  const typeMap: Record<string, string> = {
    Bug: 'fix',
    Story: 'feat',
    Task: 'chore',
    'Sub-task': 'chore',
    Epic: 'feat',
    Improvement: 'feat',
  };

  const type = typeMap[issue.type] ?? 'chore';
  const summary = issue.summary
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 50)
    .replace(/-$/, '');

  return tpl
    .replace('{key}', issue.key.toLowerCase())
    .replace('{type}', type)
    .replace('{summary}', summary);
}

/**
 * Format issue details into a context string for AI consumption.
 */
export function formatIssueContext(issue: JiraIssue): string {
  const sections: string[] = [];

  sections.push(`# ${issue.key}: ${issue.summary}`);
  sections.push('');
  sections.push(`Type: ${issue.type} | Priority: ${issue.priority} | Status: ${issue.status}`);

  if (issue.labels.length > 0) {
    sections.push(`Labels: ${issue.labels.join(', ')}`);
  }
  if (issue.components.length > 0) {
    sections.push(`Components: ${issue.components.join(', ')}`);
  }
  if (issue.parent) {
    sections.push(`Parent: ${issue.parent}`);
  }

  if (issue.description) {
    sections.push('');
    sections.push('## Description');
    sections.push('');
    sections.push(issue.description);
  }

  if (issue.subtasks.length > 0) {
    sections.push('');
    sections.push('## Subtasks');
    sections.push('');
    for (const st of issue.subtasks) {
      const done = st.status === 'Done' || st.status === 'Closed';
      sections.push(`- [${done ? 'x' : ' '}] ${st.key}: ${st.summary} (${st.status})`);
    }
  }

  if (issue.comments.length > 0) {
    sections.push('');
    sections.push('## Recent Comments');
    sections.push('');
    for (const c of issue.comments) {
      const date = new Date(c.created).toLocaleDateString();
      sections.push(`**${c.author}** (${date}):`);
      // Truncate long comments
      const body = c.body.length > 500 ? c.body.slice(0, 500) + '...' : c.body;
      sections.push(body);
      sections.push('');
    }
  }

  return sections.join('\n');
}
