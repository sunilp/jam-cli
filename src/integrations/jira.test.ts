import { describe, it, expect } from 'vitest';
import { buildBranchName, formatIssueContext } from './jira.js';
import type { JiraIssue, JiraIssueSummary } from './jira.js';

// ── buildBranchName ──────────────────────────────────────────────────────────

describe('buildBranchName', () => {
  const baseIssue: JiraIssueSummary = {
    key: 'PROJ-123',
    summary: 'Add user authentication flow',
    status: 'To Do',
    type: 'Story',
    priority: 'High',
    updated: '2024-01-15T10:00:00.000Z',
  };

  it('uses default template {key}-{summary}', () => {
    const result = buildBranchName(baseIssue);
    expect(result).toBe('proj-123-add-user-authentication-flow');
  });

  it('applies custom template with {type}', () => {
    const result = buildBranchName(baseIssue, '{type}/{key}-{summary}');
    expect(result).toBe('feat/proj-123-add-user-authentication-flow');
  });

  it('maps Bug to fix', () => {
    const bug = { ...baseIssue, type: 'Bug' };
    const result = buildBranchName(bug, '{type}/{key}-{summary}');
    expect(result).toMatch(/^fix\//);
  });

  it('maps Task to chore', () => {
    const task = { ...baseIssue, type: 'Task' };
    const result = buildBranchName(task, '{type}/{key}');
    expect(result).toBe('chore/proj-123');
  });

  it('strips special characters from summary', () => {
    const issue = { ...baseIssue, summary: 'Fix "login" page — broken (again!)' };
    const result = buildBranchName(issue);
    expect(result).toBe('proj-123-fix-login-page-broken-again');
    expect(result).not.toMatch(/[^a-z0-9/-]/);
  });

  it('truncates long summaries to 50 chars', () => {
    const issue = {
      ...baseIssue,
      summary: 'This is a very long summary that should be truncated because it exceeds fifty characters',
    };
    const result = buildBranchName(issue);
    const summaryPart = result.replace('proj-123-', '');
    expect(summaryPart.length).toBeLessThanOrEqual(50);
  });

  it('removes trailing hyphens after truncation', () => {
    const issue = {
      ...baseIssue,
      summary: 'Something that ends with a hyphen after exactly-',
    };
    const result = buildBranchName(issue);
    expect(result).not.toMatch(/-$/);
  });

  it('defaults unknown types to chore', () => {
    const issue = { ...baseIssue, type: 'CustomType' };
    const result = buildBranchName(issue, '{type}/{key}');
    expect(result).toBe('chore/proj-123');
  });
});

// ── formatIssueContext ───────────────────────────────────────────────────────

describe('formatIssueContext', () => {
  const fullIssue: JiraIssue = {
    key: 'PROJ-456',
    summary: 'Implement OAuth2 login',
    status: 'In Progress',
    type: 'Story',
    priority: 'High',
    assignee: 'Jane Doe',
    description: 'We need to add OAuth2 support for Google and GitHub login.',
    labels: ['auth', 'security'],
    components: ['backend', 'api'],
    created: '2024-01-10T08:00:00.000Z',
    updated: '2024-01-15T10:00:00.000Z',
    subtasks: [
      { key: 'PROJ-457', summary: 'Add Google OAuth', status: 'Done' },
      { key: 'PROJ-458', summary: 'Add GitHub OAuth', status: 'To Do' },
    ],
    comments: [
      { author: 'John', body: 'Use passport.js for this.', created: '2024-01-12T09:00:00.000Z' },
    ],
    parent: 'PROJ-100',
  };

  it('includes issue key and summary as heading', () => {
    const result = formatIssueContext(fullIssue);
    expect(result).toContain('# PROJ-456: Implement OAuth2 login');
  });

  it('includes type, priority, and status', () => {
    const result = formatIssueContext(fullIssue);
    expect(result).toContain('Type: Story');
    expect(result).toContain('Priority: High');
    expect(result).toContain('Status: In Progress');
  });

  it('includes labels and components', () => {
    const result = formatIssueContext(fullIssue);
    expect(result).toContain('Labels: auth, security');
    expect(result).toContain('Components: backend, api');
  });

  it('includes parent key', () => {
    const result = formatIssueContext(fullIssue);
    expect(result).toContain('Parent: PROJ-100');
  });

  it('includes description section', () => {
    const result = formatIssueContext(fullIssue);
    expect(result).toContain('## Description');
    expect(result).toContain('OAuth2 support for Google and GitHub');
  });

  it('renders subtasks with checkmarks for done items', () => {
    const result = formatIssueContext(fullIssue);
    expect(result).toContain('[x] PROJ-457: Add Google OAuth');
    expect(result).toContain('[ ] PROJ-458: Add GitHub OAuth');
  });

  it('includes recent comments', () => {
    const result = formatIssueContext(fullIssue);
    expect(result).toContain('## Recent Comments');
    expect(result).toContain('**John**');
    expect(result).toContain('Use passport.js');
  });

  it('omits sections when data is empty', () => {
    const minimal: JiraIssue = {
      ...fullIssue,
      description: null,
      labels: [],
      components: [],
      subtasks: [],
      comments: [],
      parent: null,
    };
    const result = formatIssueContext(minimal);
    expect(result).not.toContain('## Description');
    expect(result).not.toContain('Labels:');
    expect(result).not.toContain('Components:');
    expect(result).not.toContain('## Subtasks');
    expect(result).not.toContain('## Recent Comments');
    expect(result).not.toContain('Parent:');
  });
});
