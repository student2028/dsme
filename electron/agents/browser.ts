/**
 * Shared browse_page implementation for both Vercel and Builtin agents.
 *
 * Uses BrowserViewManager (WebContentsView) via browserNavigate/browserEval.
 * All operations execute directly in the main process — zero IPC overhead.
 *
 * Benefits:
 *   - Persistent WebContentsView (no re-creation per call)
 *   - loadURL() with full navigation waiting
 *   - 115s script execution timeout
 *   - Proper error handling and result extraction
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
    // Wrap in async IIFE. If the script has no explicit `return`, we try to
    // capture the last expression value. Results are force-stringified to avoid
    // non-serializable values (DOM nodes, Map/Set) causing undefined/null errors.
    const wrappedScript = `(async () => {
      try {
        const __result = await (async () => { ${script} })();
        if (__result === undefined || __result === null) {
          // Script had no return — try extracting page text as fallback
          return document.body?.innerText?.slice(0, 8000) || 'Script completed but returned no value.';
        }
        return typeof __result === 'string' ? __result : JSON.stringify(__result);
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
