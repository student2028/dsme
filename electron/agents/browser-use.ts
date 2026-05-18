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
// Parameterized: accepts startRef to avoid collisions when scanning multiple frames.
function buildSnapshotScript(startRef = 0, includeHeader = true): string {
  return `(function(startRef) {
  // Clear previous refs
  document.querySelectorAll('[data-dsme-ref]').forEach(el => el.removeAttribute('data-dsme-ref'));

  let refCounter = startRef;
  const lines = [];
  const seen = new Set();

  function assignRef(el) {
    refCounter++;
    const ref = 'e' + refCounter;
    el.setAttribute('data-dsme-ref', ref);
    return ref;
  }

  function isVisible(el) {
    const tag = el.tagName;
    if (tag === 'BODY' || tag === 'HTML') return true;
    if (!el.offsetParent) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function getLabel(el) {
    // Tier 1: standard HTML attributes (fast path)
    var attr = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('name') || '';
    if (attr.trim()) return attr.trim();

    // Tier 2: <label for="id"> association
    if (el.id) {
      var lab = document.querySelector('label[for="' + el.id + '"]');
      if (lab) { var t = (lab.innerText || '').trim(); if (t && t.length < 30) return t; }
    }

    // Tier 3: parent's direct text (e.g. <div>主题 <input/></div>)
    var parent = el.parentElement;
    if (parent) {
      // Get only the parent's own text nodes (not children's text)
      var ownText = '';
      for (var i = 0; i < parent.childNodes.length; i++) {
        if (parent.childNodes[i].nodeType === 3) ownText += parent.childNodes[i].textContent;
      }
      ownText = ownText.trim();
      if (ownText && ownText.length > 0 && ownText.length < 20) return ownText;
    }

    // Tier 4: previous sibling text (e.g. <span>主题</span><input/>)
    var prev = el.previousElementSibling;
    if (prev) {
      var pt = (prev.innerText || prev.textContent || '').trim();
      if (pt && pt.length > 0 && pt.length < 20) return pt;
    }

    // Tier 5: parent's previous sibling (e.g. <td>主题</td><td><input/></td>)
    if (parent && parent.previousElementSibling) {
      var pp = (parent.previousElementSibling.innerText || '').trim();
      if (pp && pp.length > 0 && pp.length < 20) return pp;
    }

    return '';
  }

  function getText(el) {
    const t = el.innerText || el.textContent || '';
    return t.trim().replace(/\s+/g, ' ').slice(0, 80);
  }

  ${includeHeader ? `
  lines.push('Page: ' + document.title);
  lines.push('URL: ' + location.href);
  lines.push('');

  var loadingEls = document.querySelectorAll('[aria-busy="true"], .loading, .spinner, [role="progressbar"], mat-progress-spinner, .generating, .thinking');
  var visibleLoading = Array.from(loadingEls).filter(function(el) { return el.offsetParent !== null; });
  if (visibleLoading.length > 0) {
    lines.push('⚠️ PAGE STATE: LOADING (' + visibleLoading.length + ' indicators — wait!)');
    lines.push('');
  }` : ''}

  // Check if body itself is contenteditable (rich text editor iframes)
  if (document.body && document.body.getAttribute('contenteditable') === 'true') {
    var ref = assignRef(document.body);
    var bodyText = (document.body.innerText || '').trim().slice(0, 60);
    var valPart = bodyText ? ' value="' + bodyText + '"' : '';
    lines.push('[' + ref + '] editable "rich-text-body"' + valPart);
  }

  // Single pass combined selector: preserves document flow for high visibility.
  // Text elements (label, legend, th, p, li) are included so they appear
  // in correct visual order relative to interactive elements.
  var allEls = document.querySelectorAll(
    'a[href], button, input:not([type=hidden]), textarea, select, ' +
    '[role="button"], [role="link"], [role="textbox"], [role="searchbox"], ' +
    '[role="combobox"], [role="tab"], [role="menuitem"], [role="option"], ' +
    '[role="switch"], [role="slider"], [role="checkbox"], [role="radio"], ' +
    '[contenteditable="true"], ' +
    '[tabindex]:not([tabindex="-1"]):not(body), ' +
    'img[alt], h1, h2, h3, h4, h5, h6, ' +
    'label, legend, caption, th, dt, p, li'
  );

  var textSeen = new Set();
  var textLineCount = 0;
  var TEXT_LINE_CAP = 60; // max text-only lines to avoid noise on content-heavy pages

  for (var i = 0; i < allEls.length; i++) {
    var el = allEls[i];
    if (!isVisible(el)) continue;
    if (seen.has(el)) continue;

    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute('role') || '';
    var isDisabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
    var disabledTag = isDisabled ? ' [DISABLED]' : '';

    var isInteractive = false;

    // Buttons
    if (tag === 'button' || role === 'button' || (tag === 'input' && (el.type === 'button' || el.type === 'submit'))) {
      var ref = assignRef(el);
      var text = getText(el) || getLabel(el) || el.value || 'button';
      lines.push('[' + ref + '] button "' + text.slice(0, 60) + '"' + disabledTag);
      seen.add(el);
      isInteractive = true;
    }
    // Links
    else if ((tag === 'a' && el.href) || role === 'link') {
      var ref = assignRef(el);
      var text = getText(el) || getLabel(el) || (el.href || '').slice(0, 40);
      lines.push('[' + ref + '] link "' + text.slice(0, 60) + '"' + disabledTag);
      seen.add(el);
      isInteractive = true;
    }
    // Text inputs
    else if (tag === 'input') {
      var ref = assignRef(el);
      var label = getLabel(el) || el.type;
      var val = el.value ? ' value="' + el.value.slice(0, 40) + '"' : '';
      lines.push('[' + ref + '] input[' + (el.type || 'text') + '] "' + label + '"' + val + disabledTag);
      seen.add(el);
      isInteractive = true;
    }
    // Textbox role
    else if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
      var ref = assignRef(el);
      var label = getLabel(el) || role;
      var val = (el.value || el.innerText || '').trim();
      var valPart = val ? ' value="' + val.slice(0, 40) + '"' : '';
      lines.push('[' + ref + '] ' + role + ' "' + label + '"' + valPart + disabledTag);
      seen.add(el);
      isInteractive = true;
    }
    // Textarea / contenteditable
    else if (tag === 'textarea' || (el.getAttribute('contenteditable') === 'true' && tag !== 'body')) {
      var ref = assignRef(el);
      var label = getLabel(el) || el.className?.split(' ')[0] || 'editable';
      var val = (el.value || el.innerText || '').trim();
      var valPart = val ? ' value="' + val.slice(0, 40) + '"' : '';
      lines.push('[' + ref + '] ' + (tag === 'textarea' ? 'textarea' : 'editable') + ' "' + label + '"' + valPart + disabledTag);
      seen.add(el);
      isInteractive = true;
    }
    // Select
    else if (tag === 'select') {
      var ref = assignRef(el);
      var label = getLabel(el) || 'select';
      var selected = el.selectedOptions?.[0]?.text || '';
      lines.push('[' + ref + '] select "' + label + '" selected="' + selected.slice(0, 30) + '"' + disabledTag);
      seen.add(el);
      isInteractive = true;
    }
    // Tab / menuitem / etc.
    else if (['tab','menuitem','option','switch','slider','checkbox','radio'].indexOf(role) >= 0) {
      var ref = assignRef(el);
      var text = getText(el) || getLabel(el) || role;
      lines.push('[' + ref + '] ' + role + ' "' + text.slice(0, 60) + '"' + disabledTag);
      seen.add(el);
      isInteractive = true;
    }
    // Images
    else if (tag === 'img' && el.alt) {
      var ref = assignRef(el);
      lines.push('[' + ref + '] img "' + el.alt.slice(0, 60) + '"');
      seen.add(el);
      isInteractive = true;
    }
    // Tabindex focusables (fallback)
    else if (el.hasAttribute('tabindex')) {
      var text = getText(el) || getLabel(el);
      if (text && text.length > 1) {
        var ref = assignRef(el);
        lines.push('[' + ref + '] interactive "' + text.slice(0, 60) + '"' + disabledTag);
        seen.add(el);
        isInteractive = true;
      }
    }

    // Static text / Headings (only process if we didn't just mark it interactive)
    if (!isInteractive) {
      var isHeading = ['h1','h2','h3','h4','h5','h6'].indexOf(tag) >= 0;
      var hasInteractiveChild = el.querySelector('input, button, select, textarea, a[href], [role="button"]');
      if (hasInteractiveChild && tag !== 'label') continue;

      var bt = '';
      for (var cn = 0; cn < el.childNodes.length; cn++) {
        if (el.childNodes[cn].nodeType === 3) bt += el.childNodes[cn].textContent;
      }
      bt = bt.trim().replace(/\s+/g, ' ');
      
      // Headings always emitted; text lines capped to avoid noise
      if (isHeading && bt) {
        if (!textSeen.has(bt)) {
          lines.push(tag + ': ' + bt);
          textSeen.add(bt);
        }
      } else if (textLineCount < TEXT_LINE_CAP && bt.length >= 2 && bt.length <= 120 && !textSeen.has(bt)) {
        lines.push('text: ' + bt);
        textSeen.add(bt);
        textSeen.add(el);
        textLineCount++;
      }
    }
  }

  return JSON.stringify({ lines: lines.slice(0, 400), lastRef: refCounter });
})(${startRef})`;
}

// Legacy compat: the old SNAPSHOT_SCRIPT constant for any remaining callers
const SNAPSHOT_SCRIPT = buildSnapshotScript(0, true);

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
 * Registry mapping JS-path refs to their frame index.
 * When CDP refs are unavailable, click/type use this to route to the correct frame.
 */
const jsRefFrameMap = new Map<string, number>();

/**
 * Get a text snapshot of the current page.
 * PRIMARY: CDP Accessibility Tree (cross-frame, semantic, zero DOM pollution)
 * FALLBACK: JS injection that PENETRATES ALL IFRAMES with unified ref space
 */
export async function browserSnapshot(): Promise<string> {
  // Try CDP accessibility tree first — this is the reliable path
  try {
    const cdpResult = await browserViewManager.getAccessibilitySnapshot();
    // Validate: CDP result must contain at least one interactive ref [eN]
    // A result with just "Page: ...\nURL: ..." but no refs means AXTree was incomplete
    if (cdpResult && /\[e\d+\]/.test(cdpResult)) {
      jsRefFrameMap.clear(); // CDP refs are active, no need for JS ref routing
      const screenshot = await browserViewManager.captureScreenshot();
      notifyBrowserStep('snapshot', {}, `${cdpResult.length} chars (CDP)`, screenshot ?? undefined);
      return cdpResult;
    }
    if (cdpResult) {
      console.warn('[browser-use] CDP AXTree returned no interactive refs, falling back to JS');
    }
  } catch (e: any) {
    console.warn('[browser-use] CDP snapshot failed, falling back to JS injection:', e.message);
  }

  // ── JS Fallback: penetrate ALL frames with unified ref counter ──
  jsRefFrameMap.clear();
  const allLines: string[] = [];
  let globalRefCounter = 0;
  const frameInfos = browserViewManager.getAllFrameInfos();

  // Save current target frame so we can restore it after scanning
  const savedFrame = (browserViewManager as any).targetFrame;

  for (const frame of frameInfos) {
    // Switch to the target frame for script execution
    if (frame.index === 0) {
      browserViewManager.switchToFrame(-1); // main frame
    } else {
      const switchResult = browserViewManager.switchToFrame(frame.index);
      if (switchResult.startsWith('Error:')) continue;
    }

    try {
      const script = buildSnapshotScript(globalRefCounter, frame.index === 0);
      const raw = await browserViewManager.executeJS(script);

      // Parse the JSON result from the snapshot script
      let parsed: { lines: string[]; lastRef: number };
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Script returned non-JSON (error or page text fallback) — skip this frame
        continue;
      }

      // Register all refs from this frame in the routing map
      for (let r = globalRefCounter + 1; r <= parsed.lastRef; r++) {
        jsRefFrameMap.set(`e${r}`, frame.index);
      }
      globalRefCounter = parsed.lastRef;

      if (parsed.lines.length > 0) {
        // Add frame header for non-main frames
        if (frame.index > 0) {
          const urlLabel = frame.url === 'about:blank'
            ? 'about:blank (rich text editor)'
            : (() => { try { return new URL(frame.url).hostname; } catch { return frame.url.slice(0, 60); } })();
          allLines.push(`\n--- iframe[${frame.index}]: ${urlLabel} ---`);
        }
        allLines.push(...parsed.lines);
      }
    } catch (e: any) {
      // Frame may have been destroyed or CSP blocked — skip
      console.warn(`[browser-use] Frame ${frame.index} snapshot failed:`, e.message);
    }
  }

  // Restore original target frame
  if (savedFrame) {
    (browserViewManager as any).targetFrame = savedFrame;
  } else {
    browserViewManager.switchToFrame(-1);
  }

  const combined = allLines.join('\n');
  const screenshot = await browserViewManager.captureScreenshot();
  notifyBrowserStep('snapshot', {}, `${combined.length} chars, ${globalRefCounter} refs, ${frameInfos.length} frames (JS)`, screenshot ?? undefined);
  return combined || 'Empty page — no visible elements found.';
}

/**
 * Switch to the correct frame for a JS ref, execute a callback, then restore.
 * Returns the callback result, or null if no frame routing was needed.
 */
async function withJsRefFrame<T>(ref: string, fn: () => Promise<T>): Promise<T> {
  const frameIndex = jsRefFrameMap.get(ref);
  if (frameIndex !== undefined && frameIndex > 0) {
    const saved = (browserViewManager as any).targetFrame;
    browserViewManager.switchToFrame(frameIndex);
    try {
      return await fn();
    } finally {
      if (saved) { (browserViewManager as any).targetFrame = saved; }
      else { browserViewManager.switchToFrame(-1); }
    }
  }
  return fn();
}

/**
 * Click element by ref.
 * PRIMARY: CDP coordinates (cross-frame, precise)
 * FALLBACK: JS injection with auto frame routing
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

  // Fallback to JS click with auto frame routing
  try {
    const jsClickResult = await withJsRefFrame(ref, () => browserViewManager.executeJS(`
      (function() {
        const el = document.querySelector('[data-dsme-ref="${ref}"]');
        if (el) { el.click(); return 'SUCCESS'; }
        return 'NOT_FOUND';
      })()
    `));
    if (jsClickResult === 'SUCCESS') {
      const frameIdx = jsRefFrameMap.get(ref);
      const frameSuffix = frameIdx && frameIdx > 0 ? ` (frame ${frameIdx})` : '';
      const result = `Clicked [${ref}]${frameSuffix} [JS]`;
      notifyBrowserStep('click', { ref }, result);
      const idleStatus = await browserViewManager.waitForIdle(8000);
      return result + ` [${idleStatus}]`;
    }
  } catch {}

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

  // Fallback: JS focus + native insertText (works for ALL element types)
  // Why not el.value=text? Custom components (126 mail subject, Quill, etc.) ignore
  // direct value assignment because their internal state isn't bound to el.value.
  // insertText fires real input events that frameworks listen to.
  try {
    const jsFocusResult = await withJsRefFrame(ref, () => browserViewManager.executeJS(`
      (function() {
        const el = document.querySelector('[data-dsme-ref="${ref}"]');
        if (!el) return 'NOT_FOUND';
        el.focus();
        // For standard inputs, also click to ensure cursor placement
        if (typeof el.click === 'function') el.click();
        // Select existing content for replacement
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          el.select();
        }
        return 'FOCUSED';
      })()
    `));
    if (jsFocusResult === 'FOCUSED') {
      // Use Cmd/Ctrl+A as a backup select-all (handles contenteditable & custom components)
      try {
        const modifier = process.platform === 'darwin' ? 4 : 2;
        await browserViewManager.cdpCommand('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'a', code: 'KeyA',
          modifiers: modifier, windowsVirtualKeyCode: 65,
        });
        await browserViewManager.cdpCommand('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'a', code: 'KeyA',
          modifiers: modifier, windowsVirtualKeyCode: 65,
        });
      } catch { /* select-all is best-effort */ }

      // Native insertText — fires real input events, works with any framework
      const insertResult = await browserViewManager.insertText(text);
      const frameIdx = jsRefFrameMap.get(ref);
      const frameSuffix = frameIdx && frameIdx > 0 ? ` (frame ${frameIdx})` : '';
      const result = `Typed into [${ref}]${frameSuffix} [JS+Native] → ${insertResult}`;
      notifyBrowserStep('type', { ref, text }, result);
      await browserViewManager.waitForIdle(800);
      return result;
    }
  } catch {}

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
