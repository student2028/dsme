/**
 * Shared browse_page implementation for both Vercel and Builtin agents.
 * Uses Electron BrowserWindow with full JS rendering + interaction capability.
 */

import type { BrowserWindow as BW_Type } from 'electron';

export interface BrowsePageOptions {
  url: string;
  script: string;
  waitMs?: number;
  timeoutMs?: number;
  show?: boolean;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MAX_OUTPUT_CHARS = 20000;

export async function browsePage(opts: BrowsePageOptions): Promise<string> {
  const { url, script, waitMs = 2000, timeoutMs = 30000, show = true } = opts;

  // ── Input validation ──
  if (!url) return 'Error: url is required';
  if (!script) return 'Error: script is required';
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return 'Error: only http/https URLs supported';
  } catch {
    return 'Error: invalid URL';
  }

  const { BrowserWindow: BW } = require('electron');

  return new Promise((resolve) => {
    let resolved = false; // Guard against double-resolve from iframe loads

    const cleanup = (win: BW_Type, timer: ReturnType<typeof setTimeout>) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {}
    };

    const win: BW_Type = new BW({
      width: 1280,
      height: 900,
      show,
      title: `DSME Browser — ${url}`,
      alwaysOnTop: show,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        javascript: true,
      },
    });
    if (show) win.focus();

    win.webContents.setUserAgent(DEFAULT_USER_AGENT);

    // Hard timeout: clean up no matter what
    const hardTimeout = setTimeout(() => {
      cleanup(win, hardTimeout);
      resolve(`Error: browse_page timed out after ${timeoutMs}ms. The page may be too slow or the script may hang.`);
    }, timeoutMs);

    // Only fire script on the main frame load, not iframes
    win.webContents.on('did-finish-load', async () => {
      if (resolved) return; // Guard against double-fire

      try {
        // Wait for dynamic content to render (SPAs, AJAX, etc.)
        await new Promise((r) => setTimeout(r, waitMs));
        if (resolved) return; // Check again after wait (timeout may have fired)

        // Wrap the user script in an async IIFE so it can use await
        // The script MUST end with a return statement
        const wrappedScript = `
          (async () => {
            try {
              ${script}
            } catch (e) {
              return 'Script error: ' + (e.message || String(e));
            }
          })()
        `;

        const result = await win.webContents.executeJavaScript(wrappedScript);
        cleanup(win, hardTimeout);

        if (result === null || result === undefined) {
          resolve('browse_page: script returned null/undefined. Make sure your script ends with a return statement.');
        } else {
          const text = String(result);
          resolve(
            text.length > MAX_OUTPUT_CHARS
              ? text.slice(0, MAX_OUTPUT_CHARS) + `\n...(truncated, total ${text.length} chars)`
              : text,
          );
        }
      } catch (e: any) {
        cleanup(win, hardTimeout);
        resolve(`Script execution error: ${e.message}`);
      }
    });

    win.webContents.on('did-fail-load', (_event: any, errorCode: number, errorDesc: string, validatedURL: string, isMainFrame: boolean) => {
      // Only care about main frame failures, not iframe/subresource failures
      if (!isMainFrame) return;
      cleanup(win, hardTimeout);
      resolve(`Page load failed: ${errorDesc} (code ${errorCode})`);
    });

    win.loadURL(url).catch((e: any) => {
      cleanup(win, hardTimeout);
      resolve(`Failed to open URL: ${e.message}`);
    });
  });
}
