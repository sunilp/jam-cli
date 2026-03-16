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
  | 'UNKNOWN';

/**
 * Actionable hints for each error code.
 * Shown below the error message to help users fix the issue.
 */
export const ERROR_HINTS: Partial<Record<ErrorCode, string>> = {
  CONFIG_INVALID:
    'Check your .jamrc or config file for syntax errors.\n' +
    'Run `jam config show` to see the merged config, or `jam init` to generate a fresh one.',
  CONFIG_NOT_FOUND:
    'The requested profile does not exist. Run `jam config show` to see available profiles.',
  PROVIDER_AUTH_FAILED:
    'Set the appropriate API key for your provider:\n' +
    '  Anthropic: export ANTHROPIC_API_KEY=sk-ant-...\n' +
    '  OpenAI:    export OPENAI_API_KEY=sk-...\n' +
    '  Groq:      export GROQ_API_KEY=gsk_...\n' +
    '  Ollama:    No API key needed — just run `ollama serve`',
  PROVIDER_UNAVAILABLE:
    'The provider is not reachable. Check your network or provider status.\n' +
    'For Ollama: make sure it\'s running with `ollama serve`\n' +
    'Run `jam doctor` for full diagnostics.',
  PROVIDER_RATE_LIMITED:
    'You\'ve hit the provider\'s rate limit. Wait a moment and try again.\n' +
    'Consider switching to a local provider: `jam ask --provider ollama "your question"`',
  PROVIDER_QUOTA_EXHAUSTED:
    'Your API quota is exhausted. This is NOT a transient error — retrying will not help.\n' +
    'Check your billing/plan at your provider\'s dashboard and add credits.\n' +
    'Or switch to a local provider: `jam ask --provider ollama "your question"`',
  PROVIDER_MODEL_NOT_FOUND:
    'The model is not available. Check available models with: `jam models list`\n' +
    'For Ollama, pull the model first: `ollama pull <model-name>`',
  PROVIDER_STREAM_ERROR:
    'The provider returned an unexpected response. This may be transient.\n' +
    'Try again, or switch providers with: `--provider <name>`',
  INPUT_MISSING:
    'Provide input as an argument, via --file, or pipe from stdin.\n' +
    'Example: jam ask "your question" or echo "question" | jam ask',
  INPUT_FILE_NOT_FOUND:
    'The specified file does not exist. Check the path and try again.',
  SECRETS_UNAVAILABLE:
    'Secure credential storage (keytar) is not available.\n' +
    'Use environment variables instead: export ANTHROPIC_API_KEY=...',
  TOOL_DENIED:
    'The tool call was denied by your tool policy.\n' +
    'Adjust toolPolicy in your config or use `--yes` to auto-approve writes.',
  TOOL_NOT_FOUND:
    'The requested tool does not exist. This is likely an internal error.',
  TOOL_EXEC_ERROR:
    'A tool failed to execute. Check that git and other dependencies are installed.\n' +
    'Run `jam doctor` for diagnostics.',
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
