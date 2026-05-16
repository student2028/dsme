/**
 * Shared browse_page implementation for both Vercel and Builtin agents.
 *
 * Uses the BrowserPanel's persistent webview via the browser-command IPC channel.
 * This ensures browse_page shares state with browser_navigate/browser_eval/browser_snapshot
 * and benefits from:
 *   - Persistent webview (no re-creation per call)
 *   - Full did-finish-load waiting
 *   - 115s script execution timeout
 *   - Proper error handling and result extraction
 *
 * Previously used WebSearchOverlay (web-search-execute) which created a temporary
 * webview with only 2.5s wait and a >20 char filter — causing "No results found"
 * on JS-rendered SPAs that need longer load times.
 */

import { browserNavigate, browserEval } from './browser-use';

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

  try {
    // Step 1: Navigate to the URL using BrowserPanel's persistent webview.
    // This waits for did-finish-load with a 60s timeout.
    const navResult = await browserNavigate(url);
    if (navResult.startsWith('Error:')) {
      return `Navigation failed: ${navResult}`;
    }

    // Step 2: Wait for dynamic content to render (SPA hydration, AJAX loads, etc.)
    if (waitMs > 0) {
      await new Promise(r => setTimeout(r, waitMs));
    }

    // Step 3: Execute the user's script in the page context.
    // browserEval uses BrowserPanel's execJS with a 115s timeout.
    // Wrap in async IIFE so the user can use await.
    const wrappedScript = `(async () => {
      try {
        ${script}
      } catch (e) {
        return 'Script error: ' + (e.message || String(e));
      }
    })()`;

    const result = await browserEval(wrappedScript);
    return result || 'Script returned empty result. The page may still be loading — try increasing wait_before_script or use browser_snapshot to inspect the page state.';
  } catch (e: any) {
    return `browse_page error: ${e.message || String(e)}`;
  }
}
