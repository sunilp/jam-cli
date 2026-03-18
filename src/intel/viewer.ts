// src/intel/viewer.ts

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

/**
 * Generate a standalone HTML page that renders a Mermaid diagram.
 *
 * Features:
 * - Embeds Mermaid.js from CDN
 * - Dark theme (dark background, light text)
 * - Auto-polls the .mmd file for changes every 3 seconds and reloads
 */
export function generateViewerHtml(mermaidContent: string, mmdFilePath: string): string {
  // Escape the mermaid content and file path for safe embedding
  const escapedContent = mermaidContent
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  const escapedFilePath = mmdFilePath.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Jam Intel — Architecture Diagram</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #1a1a2e;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    header {
      background: #16213e;
      padding: 12px 24px;
      border-bottom: 1px solid #0f3460;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    header h1 {
      font-size: 1.1rem;
      font-weight: 600;
      color: #e94560;
    }
    header .filepath {
      font-size: 0.8rem;
      color: #888;
      font-family: monospace;
    }
    .status {
      margin-left: auto;
      font-size: 0.75rem;
      color: #4caf50;
    }
    .status.stale { color: #ff9800; }
    main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      overflow: auto;
    }
    #diagram {
      background: #0d1117;
      border-radius: 8px;
      padding: 32px;
      border: 1px solid #30363d;
      max-width: 100%;
      overflow: auto;
    }
    #error {
      color: #f44336;
      font-family: monospace;
      background: #1a1a1a;
      padding: 16px;
      border-radius: 4px;
      display: none;
    }
    .mermaid svg {
      max-width: 100%;
      height: auto;
    }
  </style>
</head>
<body>
  <header>
    <h1>Jam Intel</h1>
    <span class="filepath">${mmdFilePath}</span>
    <span class="status" id="status">Live</span>
  </header>
  <main>
    <div id="diagram">
      <div class="mermaid" id="mermaid-container">${mermaidContent}</div>
      <div id="error"></div>
    </div>
  </main>

  <script>
    // Initialize Mermaid with dark theme
    mermaid.initialize({
      startOnLoad: true,
      theme: 'dark',
      themeVariables: {
        primaryColor: '#1e3a5f',
        primaryTextColor: '#e0e0e0',
        primaryBorderColor: '#4a90d9',
        lineColor: '#6fa3d4',
        sectionBkgColor: '#16213e',
        altSectionBkgColor: '#0d1b2a',
        gridColor: '#2d3748',
        secondaryColor: '#2d3748',
        tertiaryColor: '#1a2940',
      },
      securityLevel: 'loose',
    });

    // Current content for change detection
    let currentContent = \`${escapedContent}\`;
    const mmdFilePath = '${escapedFilePath}';
    const statusEl = document.getElementById('status');
    const errorEl = document.getElementById('error');

    /**
     * Poll the .mmd file for changes via fetch (file:// URLs support this in some browsers).
     * Falls back gracefully if fetch fails.
     */
    async function checkForChanges() {
      try {
        const res = await fetch(mmdFilePath, { cache: 'no-store' });
        if (!res.ok) return;
        const newContent = await res.text();
        if (newContent !== currentContent) {
          currentContent = newContent;
          await rerender(newContent);
          statusEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
          statusEl.className = 'status';
        }
      } catch {
        // Fetch may fail for file:// — that's OK, we just won't auto-reload
      }
    }

    async function rerender(content) {
      const container = document.getElementById('mermaid-container');
      errorEl.style.display = 'none';
      try {
        container.removeAttribute('data-processed');
        container.textContent = content;
        await mermaid.run({ nodes: [container] });
      } catch (err) {
        errorEl.style.display = 'block';
        errorEl.textContent = 'Diagram error: ' + err.message;
      }
    }

    // Poll every 3 seconds
    setInterval(checkForChanges, 3000);
  </script>
</body>
</html>
`;
}

/**
 * Open an HTML file in the default browser.
 * Supports macOS, Linux, and Windows.
 */
export async function openInBrowser(htmlPath: string): Promise<void> {
  const platform = process.platform;
  let cmd: string;

  if (platform === 'darwin') {
    cmd = `open "${htmlPath}"`;
  } else if (platform === 'win32') {
    cmd = `start "" "${htmlPath}"`;
  } else {
    cmd = `xdg-open "${htmlPath}"`;
  }

  await execAsync(cmd);
}
