/**
 * Fetch editor context from the VSCode extension's proxy server.
 * Returns null if not running in a VSCode terminal or server is unreachable.
 */

export interface VscodeContext {
  file: string | null;
  selection: string | null;
  selectionRange: { startLine: number; endLine: number } | null;
  gitRoot: string | null;
  workspaceFolder: string | null;
}

export async function getVscodeContext(): Promise<VscodeContext | null> {
  const port = process.env['JAM_VSCODE_LM_PORT'];
  if (!port) return null;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/context`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    return (await response.json()) as VscodeContext;
  } catch {
    return null;
  }
}
