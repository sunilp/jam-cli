export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_NOT_FOUND'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_QUOTA_EXHAUSTED'
  | 'PROVIDER_STREAM_ERROR'
  | 'PROVIDER_MODEL_NOT_FOUND'
  | 'INPUT_MISSING'
  | 'INPUT_FILE_NOT_FOUND'
  | 'SECRETS_UNAVAILABLE'
  | 'TOOL_DENIED'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_EXEC_ERROR'
  | 'UNKNOWN'
  | 'AGENT_PLAN_FAILED'
  | 'AGENT_PLAN_CYCLE'
  | 'AGENT_WORKER_TIMEOUT'
  | 'AGENT_WORKER_CANCELLED'
  | 'AGENT_FILE_LOCK_CONFLICT'
  | 'AGENT_FILE_LOCK_TIMEOUT'
  | 'AGENT_BUDGET_EXCEEDED'
  | 'AGENT_SANDBOX_UNAVAILABLE'
  | 'AGENT_RATE_LIMITED'
  | 'AGENT_MERGE_CONFLICT';

/**
 * Actionable hints for each error code.
 * Shown below the error message to help users fix the issue.
 */
export const ERROR_HINTS: Partial<Record<ErrorCode, string>> = {
  CONFIG_INVALID:
    'Your config has a syntax error.\n' +
    'Run `jam config show` to see what\'s loaded, or `jam init` to start fresh.',
  CONFIG_NOT_FOUND:
    'That profile doesn\'t exist. Run `jam config show` to see what\'s available.',
  PROVIDER_AUTH_FAILED:
    'No API key found. Set one for your provider:\n' +
    '  Anthropic: export ANTHROPIC_API_KEY=sk-ant-...\n' +
    '  OpenAI:    export OPENAI_API_KEY=sk-...\n' +
    '  Groq:      export GROQ_API_KEY=gsk_...\n' +
    '  Ollama:    No key needed — just run `ollama serve`',
  PROVIDER_UNAVAILABLE:
    'Can\'t reach the provider. If it\'s Ollama, make sure `ollama serve` is running.\n' +
    'If it\'s a remote API, check your network. Run `jam doctor` for the full picture.',
  PROVIDER_RATE_LIMITED:
    'Rate limit hit. Wait a moment and try again.\n' +
    'Or dodge it entirely: `jam ask --provider ollama "your question"`',
  PROVIDER_QUOTA_EXHAUSTED:
    'Your API quota is spent. Retrying won\'t help here.\n' +
    'Check your billing dashboard and add credits, or switch to local: `jam ask --provider ollama "your question"`',
  PROVIDER_MODEL_NOT_FOUND:
    'That model doesn\'t exist. Check what\'s available: `jam models list`\n' +
    'For Ollama, pull it first: `ollama pull <model-name>`',
  PROVIDER_STREAM_ERROR:
    'Got an unexpected response from the provider. Might be transient.\n' +
    'Try again, or switch providers with `--provider <name>`.',
  INPUT_MISSING:
    'No input. Pass it as an argument, via --file, or pipe from stdin.\n' +
    'Example: jam ask "your question" or echo "question" | jam ask',
  INPUT_FILE_NOT_FOUND:
    'That file doesn\'t exist. Double-check the path.',
  SECRETS_UNAVAILABLE:
    'Secure credential storage isn\'t available on this system.\n' +
    'Use environment variables instead: export ANTHROPIC_API_KEY=...',
  TOOL_DENIED:
    'Tool call blocked by your policy.\n' +
    'Adjust toolPolicy in config or use `--yes` to auto-approve writes.',
  TOOL_NOT_FOUND:
    'That tool doesn\'t exist. This is probably a bug on our end.',
  TOOL_EXEC_ERROR:
    'A tool failed to execute. Make sure git and other deps are installed.\n' +
    'Run `jam doctor` to check your setup.',
  AGENT_PLAN_FAILED:
    'The model couldn\'t produce a structured plan. This usually means the model is too small for the task.\n' +
    'Try a larger model or simplify the instruction.',
  AGENT_PLAN_CYCLE:
    'The plan has circular dependencies. That\'s a bug — please report it.',
  AGENT_WORKER_TIMEOUT:
    'Worker hit its round limit. Try bumping maxRoundsPerWorker in config.',
  AGENT_WORKER_CANCELLED:
    'Worker was cancelled — likely a dependency failure or user abort.',
  AGENT_FILE_LOCK_CONFLICT:
    'Two workers tried to edit the same file. The orchestrator sorted it out.',
  AGENT_FILE_LOCK_TIMEOUT:
    'File lock timed out. Another worker might be stuck.',
  AGENT_BUDGET_EXCEEDED:
    'Token budget exceeded. Reduce the scope or bump maxTotal in agent config.',
  AGENT_SANDBOX_UNAVAILABLE:
    'OS sandbox not available. Running with permissions only. Check `jam doctor`.',
  AGENT_RATE_LIMITED:
    'Provider rate limit hit. Workers paused automatically. Give it a moment.',
  AGENT_MERGE_CONFLICT:
    'Workers produced conflicting edits. You may need to resolve this manually.',
};

export class JamError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly statusCode?: number;

  constructor(
    message: string,
    code: ErrorCode,
    options: { retryable?: boolean; statusCode?: number; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = 'JamError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.statusCode !== undefined) {
      this.statusCode = options.statusCode;
    }
  }

  /** Returns the actionable hint for this error, or undefined if none. */
  get hint(): string | undefined {
    return ERROR_HINTS[this.code];
  }

  static isJamError(err: unknown): err is JamError {
    return err instanceof JamError;
  }

  static fromUnknown(err: unknown, fallbackCode: ErrorCode = 'UNKNOWN'): JamError {
    if (err instanceof JamError) return err;
    if (err instanceof Error) {
      return new JamError(err.message, fallbackCode, { cause: err });
    }
    return new JamError(String(err), fallbackCode);
  }
}
