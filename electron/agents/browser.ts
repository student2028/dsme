/**
 * Shared browse_page implementation for both Vercel and Builtin agents.
 *
 * Delegates to the renderer's <webview> panel so the page is
 * directly visible through CDP remote debugging.
 * The renderer creates a webview, loads the URL, runs the user's script,
 * and sends back the result via IPC.
 */

export interface BrowsePageOptions {
  url: string;
  script: string;
  waitMs?: number;
  timeoutMs?: number;
  show?: boolean;
}

export async function browsePage(opts: BrowsePageOptions): Promise<string> {
  const { url, script, waitMs = 2000, timeoutMs = 30000 } = opts;

  // ── Input validation ──
  if (!url) return 'Error: url is required';
  if (!script) return 'Error: script is required';
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return 'Error: only http/https URLs supported';
  } catch {
    return 'Error: invalid URL';
  }

  const { BrowserWindow: BW, ipcMain } = require('electron');

  const allWindows = BW.getAllWindows();
  const mainWindow = allWindows.find((w: any) => w.getTitle()?.includes('DSME')) || allWindows[0];
  if (!mainWindow) return 'Error: no main window found';

  return new Promise<string>((resolve) => {
    const timeoutId = setTimeout(() => {
      ipcMain.removeAllListeners('web-search-results');
      resolve(`Error: browse_page timed out after ${timeoutMs}ms.`);
    }, timeoutMs);

    ipcMain.once('web-search-results', (_: any, results: string) => {
      clearTimeout(timeoutId);
      resolve(results);
    });

    // Wrap the user's script so it runs as an async IIFE with error handling
    const wrappedScript = `(async () => {
      try {
        await new Promise(r => setTimeout(r, ${waitMs}));
        ${script}
      } catch (e) {
        return 'Script error: ' + (e.message || String(e));
      }
    })()`;

    // Delegate to renderer — same webview panel as web_search
    mainWindow.webContents.send('web-search-execute', {
      query: `🌐 ${url}`,
      engines: [
        { label: 'Browser', url, extractJS: wrappedScript },
      ],
    });
  });
}
