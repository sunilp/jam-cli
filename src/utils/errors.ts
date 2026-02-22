export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_NOT_FOUND'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_STREAM_ERROR'
  | 'PROVIDER_MODEL_NOT_FOUND'
  | 'INPUT_MISSING'
  | 'INPUT_FILE_NOT_FOUND'
  | 'SECRETS_UNAVAILABLE'
  | 'TOOL_DENIED'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_EXEC_ERROR'
  | 'UNKNOWN';

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
