import type { ProviderAdapter, Message } from '../providers/base.js';
import type { TaskPlan, Subtask, WorkspaceProfile } from './types.js';
import { validateDAG } from './types.js';
import { JamError } from '../utils/errors.js';
import { formatProfileForPrompt } from './workspace-intel.js';

interface PlannerOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export async function generateTaskPlan(
  adapter: ProviderAdapter,
  prompt: string,
  profile: WorkspaceProfile,
  options?: PlannerOptions,
): Promise<TaskPlan> {
  const profileContext = formatProfileForPrompt(profile);

  const systemPrompt = `You are a task planner for an AI coding agent. Given a user task and workspace context, decompose it into subtasks with a dependency graph.

Workspace context:
${profileContext}

Respond with ONLY valid JSON matching this schema:
{
  "goal": "one sentence description",
  "subtasks": [
    {
      "id": "1",
      "description": "what to do",
      "files": [{ "path": "src/file.ts", "mode": "create" | "modify" | "read-only" }],
      "estimatedRounds": 10,
      "validationCommand": "npm test -- --grep pattern"  // optional
    }
  ],
  "dependencies": { "2": ["1"], "3": ["2"] }  // subtaskId -> [prerequisite IDs]
}

Rules:
- Each subtask should be a focused unit of work
- Files should list ALL files the subtask will touch
- Dependencies must form a DAG (no cycles)
- Use "read-only" mode for files that are only referenced
- estimatedRounds: typically 5-15 for simple, 15-25 for complex
- For simple single-file tasks, output a single subtask with no dependencies`;

  const messages: Message[] = [
    { role: 'user', content: prompt },
  ];

  // Call provider
  const response = adapter.chatWithTools
    ? await adapter.chatWithTools(messages, [], {
        model: options?.model,
        temperature: options?.temperature ?? 0.3,
        maxTokens: options?.maxTokens ?? 2000,
        systemPrompt,
      })
    : null;

  if (!response?.content) {
    throw new JamError('AGENT_PLAN_FAILED: Planner received empty response', 'AGENT_PLAN_FAILED');
  }

  // Parse JSON from response (may be wrapped in markdown code fences)
  const jsonStr = extractJSON(response.content);
  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new JamError('Planner returned invalid JSON', 'AGENT_PLAN_FAILED');
  }

  // Build TaskPlan
  const subtasks: Subtask[] = (parsed.subtasks ?? []).map((s: any) => ({
    id: String(s.id),
    description: String(s.description ?? ''),
    files: (s.files ?? []).map((f: any) => ({
      path: String(f.path),
      mode: f.mode === 'create' || f.mode === 'modify' || f.mode === 'read-only'
        ? f.mode : 'read-only',
    })),
    estimatedRounds: Number(s.estimatedRounds) || 10,
    validationCommand: s.validationCommand ? String(s.validationCommand) : undefined,
  }));

  const depGraph = new Map<string, string[]>();
  for (const st of subtasks) {
    depGraph.set(st.id, parsed.dependencies?.[st.id] ?? []);
  }

  // Validate DAG
  const cycle = validateDAG(depGraph);
  if (cycle) {
    // Re-prompt once with no-cycles constraint
    // For now, just throw
    throw new JamError(
      `AGENT_PLAN_CYCLE: Plan has circular dependencies: ${cycle.join(' → ')}`,
      'AGENT_PLAN_CYCLE',
    );
  }

  return { goal: String(parsed.goal ?? prompt), subtasks, dependencyGraph: depGraph };
}

/** Extract JSON from a string that may be wrapped in markdown code fences */
function extractJSON(text: string): string {
  // Try to find JSON in code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try to find raw JSON object
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) return objMatch[0];

  return text.trim();
}

/** Estimate token cost for a plan */
export function estimateTokenCost(plan: TaskPlan): number {
  // Rough estimate: each round uses ~1000 tokens (prompt + completion)
  const totalRounds = plan.subtasks.reduce((sum, s) => sum + s.estimatedRounds, 0);
  return totalRounds * 1000;
}
