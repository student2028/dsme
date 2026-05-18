/**
 * DSME Browser-Use — Long-running browser agent tools
 *
 * Uses WebContentsView via BrowserViewManager for zero-distance DOM operations.
 * All tools execute directly in the main process — no IPC to renderer.
 *
 * Tool set:
 *   browser_task_start(goal) — begin a named session (timeline heading + grouping)
 *   browser_task_finish(summary?) — end session (optional banner text)
 *   browser_navigate(url)   — navigate to URL
 *   browser_snapshot()      — get page snapshot with interactive element refs
 *   browser_click(ref)      — click element by ref (auto-waits for idle after click)
 *   browser_type(ref, text) — type into element (auto-waits for idle after input)
 *   browser_scroll(dir)     — scroll page
 *   browser_back()          — go back
 *   browser_eval(script)    — run arbitrary JS in page context
 *   browser_wait_for_idle() — explicitly wait for page to settle
 *
 * ## Hardening (v2)
 *   - browser_click/type automatically call waitForIdle() after action
 *   - browser_eval auto-saves base64/large binary data to disk
 *   - browser_navigate waits for initial idle after loadURL
 *   - All results include page state hints (idle/loading) for model self-correction
 */

import { browserViewManager } from '../browser-view-manager';
import * as path from 'node:path';
import * as fsP from 'node:fs/promises';

// ── Snapshot JS — runs inside the page context ──
// Builds an accessibility-tree-like text representation.
// Each interactive element gets a ref (e1, e2, ...) stored as a data attribute.
const SNAPSHOT_SCRIPT = `(function() {
  // Clear previous refs
  document.querySelectorAll('[data-dsme-ref]').forEach(el => el.removeAttribute('data-dsme-ref'));

  let refCounter = 0;
  const lines = [];
  const seen = new Set();

  function assignRef(el) {
    refCounter++;
    const ref = 'e' + refCounter;
    el.setAttribute('data-dsme-ref', ref);
    return ref;
  }

  function isVisible(el) {
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function getLabel(el) {
    return (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || '').trim();
  }

  function getText(el) {
    const t = el.innerText || el.textContent || '';
    return t.trim().replace(/\\\\s+/g, ' ').slice(0, 80);
  }

  // Page metadata
  lines.push('Page: ' + document.title);
  lines.push('URL: ' + location.href);
  lines.push('');

  // Page state indicators (help model understand if page is still loading)
  const loadingEls = document.querySelectorAll('[aria-busy="true"], .loading, .spinner, [role="progressbar"], mat-progress-spinner, .generating, .thinking');
  const visibleLoading = Array.from(loadingEls).filter(el => el.offsetParent !== null);
  if (visibleLoading.length > 0) {
    lines.push('⚠️ PAGE STATE: LOADING (found ' + visibleLoading.length + ' loading indicators — wait before interacting!)');
    lines.push('');
  }

  // Walk interactive elements
  const interactives = document.querySelectorAll('a, button, input, textarea, select, [role="button"], [contenteditable="true"], img, h1, h2, h3, h4, h5, h6, p, li');
  for (const el of interactives) {
    if (!isVisible(el)) continue;
    if (seen.has(el)) continue;

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';
    const isDisabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
    const disabledTag = isDisabled ? ' [DISABLED]' : '';

    // Interactive elements
    if (tag === 'a' && el.href) {
      const ref = assignRef(el);
      const text = getText(el) || getLabel(el) || el.href;
      lines.push('[' + ref + '] link "' + text.slice(0, 60) + '"' + disabledTag);
      seen.add(el);
    }
    else if (tag === 'button' || role === 'button' || (tag === 'input' && (el.type === 'button' || el.type === 'submit'))) {
      const ref = assignRef(el);
      const text = getText(el) || getLabel(el) || el.value || 'button';
      lines.push('[' + ref + '] button "' + text.slice(0, 60) + '"' + disabledTag);
      seen.add(el);
    }
    else if (tag === 'input' && el.type !== 'hidden') {
      const ref = assignRef(el);
      const label = getLabel(el) || el.name || el.type;
      const val = el.value ? ' value="' + el.value.slice(0, 40) + '"' : '';
      lines.push('[' + ref + '] input[' + (el.type || 'text') + '] "' + label + '"' + val + disabledTag);
      seen.add(el);
    }
    else if (tag === 'textarea' || (el.getAttribute('contenteditable') === 'true')) {
      const ref = assignRef(el);
      const label = getLabel(el) || el.name || el.className?.split(' ')[0] || 'editable';
      const val = (el.value || el.innerText || '').trim();
      const valDisplay = val ? ' value="' + val.slice(0, 40) + '"' : '';
      lines.push('[' + ref + '] ' + (tag === 'textarea' ? 'textarea' : 'editable') + ' "' + label + '"' + valDisplay + disabledTag);
      seen.add(el);
    }
    else if (tag === 'select') {
      const ref = assignRef(el);
      const label = getLabel(el) || el.name || 'select';
      const selected = el.selectedOptions?.[0]?.text || '';
      lines.push('[' + ref + '] select "' + label + '" selected="' + selected.slice(0, 30) + '"' + disabledTag);
      seen.add(el);
    }
    // Content elements
    else if (['h1','h2','h3','h4','h5','h6'].includes(tag)) {
      const text = getText(el);
      if (text) lines.push(tag + ': ' + text);
    }
    else if (tag === 'img' && (el.alt || el.src)) {
      const ref = assignRef(el);
      lines.push('[' + ref + '] img "' + (el.alt || el.src.slice(-40)) + '"');
    }
    else if (tag === 'p' || tag === 'li') {
      // Only include if it has direct text (not child elements' text)
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim())
        .join(' ')
        .trim();
      if (directText.length > 10 && directText.length < 200) {
        lines.push('text: ' + directText.slice(0, 120));
      }
    }
  }

  // Cap output size for LLM context
  return lines.slice(0, 150).join('\\\\n');
})()`;

// ── Lightweight iframe info script — NO ref injection ──
// Used by browserSnapshot() to report what's inside each iframe without
// creating ref collisions. Reports element counts and visible text hints.
// Also detects contenteditable elements (rich text editors like KindEditor,
// TinyMCE, etc. that use contenteditable body inside about:blank iframes).
const IFRAME_INFO_SCRIPT = `(function() {
  var title = document.title || '';
  var inputs = document.querySelectorAll('input:not([type=hidden])');
  var buttons = document.querySelectorAll('button, [role=button], input[type=submit]');
  var links = document.querySelectorAll('a[href]');
  var editables = document.querySelectorAll('[contenteditable="true"]');

  var visInputs = 0, visButtons = 0, visLinks = 0, visEditables = 0;
  inputs.forEach(function(el) { if (el.offsetParent) visInputs++; });
  buttons.forEach(function(el) { if (el.offsetParent) visButtons++; });
  links.forEach(function(el) { if (el.offsetParent) visLinks++; });
  editables.forEach(function(el) { visEditables++; });

  // Also check if body itself is contenteditable (common in rich text editor iframes)
  if (document.body && document.body.getAttribute('contenteditable') === 'true') {
    visEditables++;
  }

  if (visInputs === 0 && visButtons === 0 && visLinks === 0 && visEditables === 0) return '';

  var parts = [];
  if (title) parts.push('Title: ' + title);
  parts.push('Elements: ' + visInputs + ' inputs, ' + visButtons + ' buttons, ' + visLinks + ' links, ' + visEditables + ' editables');

  if (visEditables > 0) {
    parts.push('⚡ RICH TEXT EDITOR detected (contenteditable)');
    var bodyText = (document.body.innerText || '').trim().slice(0, 80);
    if (bodyText) parts.push('Editor content: "' + bodyText + '"');
  }

  var inputHints = [];
  inputs.forEach(function(el) {
    if (!el.offsetParent) return;
    var hint = el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.getAttribute('name') || el.type;
    if (hint) inputHints.push(hint);
  });
  if (inputHints.length > 0) parts.push('Input hints: ' + inputHints.slice(0, 5).join(', '));

  var btnLabels = [];
  buttons.forEach(function(el) {
    if (!el.offsetParent) return;
    var label = (el.innerText || el.getAttribute('aria-label') || el.value || '').trim().slice(0, 30);
    if (label) btnLabels.push(label);
  });
  if (btnLabels.length > 0) parts.push('Buttons: ' + btnLabels.slice(0, 5).join(', '));

  return parts.join(' | ');
})()`;




/** Active multi-step browser session title. */
let activeSessionTitle: string | null = null;

/** Get the main window via browserViewManager — no dynamic require needed. */
function getMainWindow(): any {
  return (browserViewManager as any).mainWindow;
}

/** Notify renderer about browser-use steps (for UI timeline). */
function notifyBrowserStep(command: string, params: Record<string, any>, result: string, screenshotUrl?: string) {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send('browser-step', {
    command,
    sessionTitle: activeSessionTitle,
    params,
    result,
    screenshotUrl,
    timestamp: Date.now(),
  });
}

// ── Exported tool functions (called by the agent) ──

/** Start a named browser task. */
export async function browserTaskStart(goal: string): Promise<string> {
  const title = String(goal || '').trim().slice(0, 240) || 'Browser task';
  activeSessionTitle = title;
  notifyBrowserStep('task_start', { goal: title }, title);
  return `Browser task started: ${title}`;
}

/** End the current browser task session. */
export async function browserTaskFinish(summary?: string): Promise<string> {
  const prev = activeSessionTitle;
  activeSessionTitle = null;
  const s = String(summary ?? '').trim().slice(0, 2000);
  notifyBrowserStep('task_finish', { summary: s, sessionTitle: prev || undefined }, s || 'finished');
  return s ? `Browser task finished.\n${s}` : 'Browser task finished.';
}

/** Navigate to URL — directly via WebContentsView. Auto-waits for initial idle. */
export async function browserNavigate(url: string): Promise<string> {
  // Ensure browser panel is visible in the UI
  ensureBrowserPanelOpen();
  // Reset target frame on navigation (old frames become invalid)
  browserViewManager.resetTargetFrame();
  const result = await browserViewManager.navigate(url);
  notifyBrowserStep('navigate', { url }, result);
  // Capture screenshot after navigation settles
  await browserViewManager.waitForIdle(5000);
  const screenshot = await browserViewManager.captureScreenshot();
  if (screenshot) {
    notifyBrowserStep('navigate_screenshot', {}, 'Page loaded', screenshot);
  }
  return result;
}

/**
 * Get a text snapshot of the current page.
 * PRIMARY: CDP Accessibility Tree (cross-frame, semantic, zero DOM pollution)
 * FALLBACK: JS injection (for when CDP is unavailable)
 */
export async function browserSnapshot(): Promise<string> {
  // Try CDP accessibility tree first — this is the reliable path
  try {
    const cdpResult = await browserViewManager.getAccessibilitySnapshot();
    if (cdpResult && cdpResult.length > 50) {
      const screenshot = await browserViewManager.captureScreenshot();
      notifyBrowserStep('snapshot', {}, `${cdpResult.length} chars (CDP)`, screenshot ?? undefined);
      return cdpResult;
    }
  } catch (e: any) {
    console.warn('[browser-use] CDP snapshot failed, falling back to JS injection:', e.message);
  }

  // Fallback: JS injection snapshot (legacy path)
  const mainResult = await browserViewManager.executeJS(SNAPSHOT_SCRIPT);
  
  // Lightweight iframe exploration for JS fallback
  let combined = mainResult;
  const frameInfos = browserViewManager.getAllFrameInfos();
  if (frameInfos.length > 1) {
    try {
      const frameResults = await browserViewManager.executeJSAllFrames(IFRAME_INFO_SCRIPT, 5000);
      for (const fr of frameResults) {
        if (fr.frameIndex === 0) continue;
        if (fr.result.length > 20) {
          const urlLabel = fr.frameUrl === 'about:blank' ? 'about:blank (likely rich text editor)' : fr.frameUrl.slice(0, 80);
          combined += `\n\n--- iframe[${fr.frameIndex}]: ${urlLabel} ---\n${fr.result}\n⚡ To interact with this iframe, call: browser_switch_frame(${fr.frameIndex}) then browser_snapshot()`;
        }
      }
    } catch (e: any) {
      console.warn('[browser-use] iframe scan failed:', e.message);
    }
    if (!combined.includes('iframe[')) {
      combined += `\n\n📌 Page has ${frameInfos.length - 1} iframe(s). Use browser_list_frames() for details.`;
    }
  }
  
  const screenshot = await browserViewManager.captureScreenshot();
  notifyBrowserStep('snapshot', {}, `${combined.length} chars (JS fallback)`, screenshot ?? undefined);
  return combined;
}

/**
 * Click element by ref.
 * PRIMARY: CDP coordinates (cross-frame, precise)
 * FALLBACK: JS injection coordinates → JS el.click()
 * AUTO-RETRY: if ref not found, takes a fresh snapshot once and retries
 */
export async function browserClick(ref: string, _retry = false): Promise<string> {
  // Try CDP path first — works cross-frame without offset hacks
  const cdpCenter = await browserViewManager.getElementCenterByCDP(ref);
  if (cdpCenter) {
    // Flash orange highlight before clicking — agent's intent is visible to the user
    await browserViewManager.highlightRef(ref, 600);
    const clickResult = await browserViewManager.nativeMouseClick(cdpCenter.x, cdpCenter.y);
    const result = `Clicked [${ref}]: ${cdpCenter.label} (${clickResult}) [CDP]`;
    notifyBrowserStep('click', { ref }, result);
    const idleStatus = await browserViewManager.waitForIdle(8000);
    return result + ` [${idleStatus}]`;
  }

  // Ref not found — page state may have changed (dynamic UI like login forms).
  // Auto-retry once with a fresh snapshot.
  if (!_retry) {
    console.log(`[browser-use] Ref ${ref} not found, taking fresh snapshot and retrying...`);
    await browserSnapshot(); // refresh refMap
    return browserClick(ref, true);
  }

  const errorResult = `Error: ref ${ref} not found on page. It may have been removed or the page navigated. Run browser_snapshot again.`;
  notifyBrowserStep('click', { ref }, errorResult);
  return errorResult;
}

/**
 * Type into element by ref.
 * PRIMARY: CDP focus + native click + insertText (cross-frame)
 * FALLBACK: JS focus/select + insertText
 * AUTO-RETRY: if ref not found, takes a fresh snapshot once and retries
 */
export async function browserType(ref: string, text: string, _retry = false): Promise<string> {
  // Try CDP path: get coordinates → native click → CDP focus → insertText
  const cdpCenter = await browserViewManager.getElementCenterByCDP(ref);
  if (cdpCenter) {
    // Flash orange highlight before typing — agent's intent is visible
    await browserViewManager.highlightRef(ref, 800);

    // Native click to focus (triggers real focus/click events on the element)
    await browserViewManager.nativeMouseClick(cdpCenter.x, cdpCenter.y);
    await new Promise(r => setTimeout(r, 100));
    
    // CDP focus to ensure the element is focused (handles contenteditable in iframes)
    await browserViewManager.focusElementByCDP(ref);
    
    // Select all existing content for replacement — engine-level Ctrl/Cmd+A.
    // This works in any frame context (including cross-origin iframes) because
    // it's dispatched at the Chromium input level, not as injected JS.
    // The previous Runtime.callFunctionOn approach silently failed for cross-origin elements.
    try {
      const modifier = process.platform === 'darwin' ? 4 : 2; // 4=Meta, 2=Ctrl
      await browserViewManager.cdpCommand('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'a', code: 'KeyA',
        modifiers: modifier, windowsVirtualKeyCode: 65,
      });
      await browserViewManager.cdpCommand('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA',
        modifiers: modifier, windowsVirtualKeyCode: 65,
      });
    } catch { /* select-all is best-effort */ }

    const insertResult = await browserViewManager.insertText(text);
    const result = `Focused [${ref}] via CDP → ${insertResult}`;
    notifyBrowserStep('type', { ref, text }, result);
    // Brief wait after typing (reduced to 800ms max to prevent slowing down multi-field form fills)
    await browserViewManager.waitForIdle(800);
    return result;
  }

  // Ref not found — page state may have changed (e.g. password field appeared after email entry).
  // Auto-retry once with a fresh snapshot before failing.
  if (!_retry) {
    console.log(`[browser-use] Ref ${ref} not found for type, taking fresh snapshot and retrying...`);
    await browserSnapshot(); // refresh refMap
    return browserType(ref, text, true);
  }

  const errorResult = `Error: ref ${ref} not found on page. Run browser_snapshot again.`;
  notifyBrowserStep('type', { ref, text }, errorResult);
  return errorResult;
}

/** Press a special key (Enter, Tab, Escape, etc.) using native Electron input events. */
export async function browserPressKey(key: string): Promise<string> {
  const result = await browserViewManager.pressKey(key);
  notifyBrowserStep('press_key', { key }, result);
  // Wait for potential side effects (form submit, navigation, etc.)
  if (!result.startsWith('Error:')) {
    await browserViewManager.waitForIdle(5000);
  }
  return result;
}

/** Scroll page using engine-level mouseWheel input (no JS injection needed). */
export async function browserScroll(direction: 'up' | 'down'): Promise<string> {
  const deltaY = direction === 'down' ? -600 : 600;
  browserViewManager.sendMouseWheel(deltaY);
  await new Promise(r => setTimeout(r, 300)); // Let scroll settle
  // Report position via a lightweight eval
  let position = '';
  try {
    position = await browserViewManager.executeJS(
      `'scrollY=' + window.scrollY + ' / ' + document.body.scrollHeight`
    );
  } catch { position = 'unknown'; }
  const result = `Scrolled ${direction}. ${position}`;
  notifyBrowserStep('scroll', { direction }, result);
  return result;
}

/** Go back in history. */
export async function browserBack(): Promise<string> {
  const result = await browserViewManager.goBack();
  notifyBrowserStep('back', {}, result);
  // Wait for page to settle after navigation
  await browserViewManager.waitForIdle(5000);
  return result;
}

/** Run arbitrary JS in page context. Auto-saves base64/large binary to disk. */
export async function browserEval(script: string, cwd?: string): Promise<string> {
  const result = await browserViewManager.executeJS(script);
  notifyBrowserStep('eval', { script: script.slice(0, 200) }, result.slice(0, 500));

  // ── Auto-intercept base64 data (images/binary) — save to disk instead of polluting context ──
  if (result.length > 5000 && /^data:[a-z]+\/[a-z+]+;base64,/i.test(result)) {
    const workDir = cwd || process.cwd();
    const match = result.match(/^data:([a-z]+)\/([a-z+]+);base64,/i);
    const ext = match?.[2]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') || 'bin';
    const filename = `scratch/browser_image_${Date.now()}.${ext}`;
    const fp = path.resolve(workDir, filename);
    try {
      await fsP.mkdir(path.dirname(fp), { recursive: true });
      const base64Data = result.replace(/^data:[^;]+;base64,/, '');
      await fsP.writeFile(fp, Buffer.from(base64Data, 'base64'));
      return `Image saved to ${filename} (${Math.round(base64Data.length * 0.75 / 1024)}KB). Use this file path to reference the image. Do NOT re-extract — the file is ready.`;
    } catch (e: any) {
      return `Failed to save image: ${e.message}. Raw data length: ${result.length} chars.`;
    }
  }

  return result;
}

/** Explicitly wait for page to become idle. Use after actions that trigger async operations. */
export async function browserWaitForIdle(maxWaitMs?: number): Promise<string> {
  const ms = maxWaitMs ?? 15000;
  const result = await browserViewManager.waitForIdle(ms);
  notifyBrowserStep('wait_idle', { maxWaitMs: ms }, result);
  return result;
}

/** Tell the renderer to open the browser panel tab. */
function ensureBrowserPanelOpen() {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('browser-panel-open');
  }
}

// ── iframe management tools ──

/** List all frames (main + iframes) with their URLs and indices. */
export async function browserListFrames(): Promise<string> {
  const frames = browserViewManager.getAllFrameInfos();
  if (frames.length === 0) return 'No frames found. Is a page loaded?';
  const lines = frames.map(f => 
    `[${f.index}] ${f.isMain ? '(main)' : '(iframe)'} ${f.url.slice(0, 120)}`
  );
  const result = `Found ${frames.length} frame(s):\n${lines.join('\n')}`;
  notifyBrowserStep('list_frames', {}, result);
  return result;
}

/**
 * Switch browser_* tool execution context to a specific frame.
 * After switching, browser_snapshot/click/type/eval will operate inside that frame.
 * Use frameIndex=-1 to switch back to the main frame.
 */
export async function browserSwitchFrame(frameIndex: number): Promise<string> {
  const result = browserViewManager.switchToFrame(frameIndex);
  notifyBrowserStep('switch_frame', { frameIndex }, result);
  return result;
}

// ── Electron Native tools (unique to DSME — impossible for extensions/Playwright) ──

/**
 * Search for text on the page using Chromium's built-in find-in-page.
 * Works across shadow DOM, cross-origin iframes, and canvas text.
 * The first match is automatically scrolled into view and highlighted.
 */
export async function browserFind(text: string): Promise<string> {
  const result = await browserViewManager.findInPage(text);
  const msg = result.matches > 0
    ? `Found ${result.matches} match(es) for "${text}" — match ${result.activeMatch} scrolled into view`
    : `No matches found for "${text}"`;
  notifyBrowserStep('find', { text }, msg);
  return msg;
}

/** Stop find-in-page and clear highlights. */
export async function browserStopFind(): Promise<string> {
  browserViewManager.stopFind();
  return 'Find highlights cleared';
}

/**
 * Export all cookies for the browser session.
 * Returns cookies as JSON. Can be saved to disk and imported later
 * to restore login sessions without re-authentication.
 */
export async function browserExportCookies(url?: string): Promise<string> {
  const cookies = url
    ? await browserViewManager.getCookiesForUrl(url)
    : await browserViewManager.exportCookies();
  const summary = `Exported ${cookies.length} cookies` + (url ? ` for ${url}` : ' (all)');
  notifyBrowserStep('export_cookies', { url }, summary);

  // Save to disk for persistence
  const fp = path.resolve(process.cwd(), `scratch/cookies_${Date.now()}.json`);
  await fsP.mkdir(path.dirname(fp), { recursive: true });
  await fsP.writeFile(fp, JSON.stringify(cookies, null, 2));
  return `${summary}. Saved to ${fp}`;
}

/**
 * Import cookies from a JSON file to restore a previous session.
 */
export async function browserImportCookies(filePath: string): Promise<string> {
  try {
    const data = await fsP.readFile(filePath, 'utf-8');
    const cookies = JSON.parse(data);
    const result = await browserViewManager.importCookies(cookies);
    notifyBrowserStep('import_cookies', { filePath }, result);
    return result;
  } catch (e: any) {
    return `Error importing cookies: ${e.message}`;
  }
}

/** Clear all cookies, localStorage, and cache for the browser session. */
export async function browserClearSession(): Promise<string> {
  const result = await browserViewManager.clearSession();
  notifyBrowserStep('clear_session', {}, result);
  return result;
}

/** Set page zoom level (1.0 = 100%, 0.5 = 50%, 2.0 = 200%). */
export async function browserZoom(factor: number): Promise<string> {
  browserViewManager.setZoom(factor);
  const actual = browserViewManager.getZoom();
  const result = `Zoom set to ${Math.round(actual * 100)}%`;
  notifyBrowserStep('zoom', { factor }, result);
  return result;
}

/** Export the current page as a PDF file to disk. */
export async function browserExportPDF(outputPath?: string): Promise<string> {
  const result = await browserViewManager.exportPDF(outputPath);
  notifyBrowserStep('export_pdf', { outputPath }, result);
  return result;
}

/** Read the current system clipboard text (Electron Native — no user gesture needed). */
export async function browserReadClipboard(): Promise<string> {
  const result = browserViewManager.readClipboard();
  notifyBrowserStep('clipboard_read', {}, result.slice(0, 100));
  return result;
}

/** Write text to the system clipboard (Electron Native). */
export async function browserWriteClipboard(text: string): Promise<string> {
  const result = browserViewManager.writeClipboard(text);
  notifyBrowserStep('clipboard_write', {}, result);
  return result;
}

/**
 * Get a comprehensive page health summary (Electron Native — zero JS injection).
 * Returns URL, title, loading state, network activity, error count, zoom, and nav history.
 * Use this for quick situational awareness before deciding whether to snapshot.
 */
export async function browserPageHealth(): Promise<string> {
  const h = browserViewManager.getPageHealth();
  const networkStatus = h.networkActiveMs < 0
    ? 'no network activity yet'
    : h.networkActiveMs < 1000 ? `network active ${h.networkActiveMs}ms ago`
    : 'network quiet';
  const parts = [
    `URL: ${h.url}`,
    `Title: ${h.title}`,
    `Loading: ${h.loading ? 'YES' : 'no'}`,
    `Network: ${networkStatus}`,
    `Errors (30s): ${h.recentErrors}`,
    `Zoom: ${Math.round(h.zoom * 100)}%`,
    `History: ${h.canGoBack ? 'can go back' : 'no back'} | ${h.canGoForward ? 'can go forward' : 'no forward'}`,
  ];
  const result = parts.join(' | ');
  notifyBrowserStep('page_health', {}, result);
  return result;
}
/**
 * Show all page elements (refs) as blue highlighted boxes — "X-ray vision" mode.
 * Renders colored overlays via CDP Overlay domain (same as Chrome DevTools inspector).
 * No DOM injection: composited above all page content by Chromium itself.
 * Use to understand what the agent "sees" and verify ref coverage.
 */
export async function browserShowOverlay(): Promise<string> {
  const result = await browserViewManager.highlightAllRefs();
  notifyBrowserStep('show_overlay', {}, result);
  return result;
}

/** Clear all element overlays from the page. */
export async function browserClearOverlay(): Promise<string> {
  await browserViewManager.clearOverlay();
  notifyBrowserStep('clear_overlay', {}, 'Overlay cleared');
  return 'Overlay cleared';
}

/** Highlight a specific element ref with an orange box (same as pre-click flash). */
export async function browserHighlightRef(ref: string): Promise<string> {
  await browserViewManager.highlightRef(ref, 3000); // 3s for manual inspection
  const label = browserViewManager.getRefLabel(ref); // use public API, not any-cast
  const result = `Highlighted [${ref}]: ${label} (orange, 3s)`;
  notifyBrowserStep('highlight_ref', { ref }, result);
  return result;
}

/**
 * Set file(s) on a file input element — bypasses the native file picker dialog.
 * Use when the page has a file upload form (e.g. email attachments, avatar, documents).
 * The ref MUST be an <input type="file"> element from browser_snapshot.
 */
export async function browserUploadFile(ref: string, filePaths: string[]): Promise<string> {
  const result = await browserViewManager.setFileForUpload(ref, filePaths);
  notifyBrowserStep('upload_file', { ref, filePaths }, result);
  return result;
}

/**
 * Capture the next network response matching a URL pattern.
 * Use this to intercept XHR/fetch API responses on the current page.
 * Call this BEFORE triggering the action that makes the request (e.g. click search button).
 * The function will wait for a matching response and return its body.
 */
export async function browserCaptureNetwork(urlPattern: string, timeoutMs?: number): Promise<string> {
  notifyBrowserStep('capture_network', { urlPattern }, `Waiting for response matching "${urlPattern}"...`);
  const result = await browserViewManager.captureNetworkResponse(urlPattern, timeoutMs);
  return result;
}
