import type { TelemetrySink } from '../telemetry.js';

export interface DirEntry { name: string; kind: 'file' | 'dir' | 'other' }

export interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  list(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<{ size: number; isFile: boolean; isDir: boolean } | undefined>;
  realpath(path: string): Promise<string>;
  mkdtemp(prefix: string): Promise<string>;
}

export interface ProcRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Telemetry sink for streamed chunks. Never the journal. */
  telemetry?: TelemetrySink;
  callId?: string;
}

export interface ProcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /**
   * The process could not be started at all (binary missing, EACCES).
   * Distinct from a process that started and was killed, which also reports
   * exitCode -1 because `close` gives a null code.
   */
  spawnFailed: boolean;
  durationMs: number;
}

export interface SubprocessRuntime {
  /** Never rejects for a non-zero exit. Failure is reported in the result. */
  run(req: ProcRequest): Promise<ProcResult>;
}

export interface TerminalRuntime {
  /** Reserved for interactive PTY work in sub-project 2. */
  supportsPty(): boolean;
}

export interface ExecutionWorld {
  fs: FileSystem;
  subprocess: SubprocessRuntime;
  terminal: TerminalRuntime;
}
