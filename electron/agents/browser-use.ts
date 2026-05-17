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

// ── Click by ref ──
function clickScript(ref: string): string {
  return `(function() {
    try {
      const el = document.querySelector('[data-dsme-ref="${ref}"]');
      if (!el) return 'Error: element [${ref}] not found. Run browser_snapshot to get current refs.';
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return 'Error: element [${ref}] is DISABLED. Wait for page to finish loading before clicking.';
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.click();
      return 'Clicked [${ref}]: ' + (el.getAttribute('aria-label') || el.innerText || el.tagName).slice(0, 50);
    } catch (e) {
      return 'Error clicking [${ref}]: ' + e.message;
    }
  })()`;
}

// ── Focus + select-all by ref (preparation for native insertText) ──
// Instead of clearing (which breaks under React's hijacked value setter),
// we select all existing content. The subsequent insertText() replaces the selection.
function focusAndSelectAllScript(ref: string): string {
  return `(function() {
    try {
      const el = document.querySelector('[data-dsme-ref="${ref}"]');
      if (!el) return 'Error: element [${ref}] not found. Run browser_snapshot to get current refs.';
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus();
      // Select all existing content — insertText will replace the selection
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.select(); // Native DOM method, unaffected by React's value setter hijack
      } else if (el.getAttribute('contenteditable') === 'true') {
        const sel = window.getSelection();
        if (sel) {
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      return 'Focused [${ref}]: ' + (el.getAttribute('aria-label') || el.tagName).slice(0, 50);
    } catch (e) {
      return 'Error focusing [${ref}]: ' + e.message;
    }
  })()`;
}

// ── Scroll ──
function scrollScript(direction: 'up' | 'down'): string {
  const amount = direction === 'down' ? 600 : -600;
  return `(function() {
    window.scrollBy({ top: ${amount}, behavior: 'smooth' });
    return 'Scrolled ${direction}. scrollY=' + window.scrollY + ' / ' + document.body.scrollHeight;
  })()`;
}

/** Active multi-step browser session title. */
let activeSessionTitle: string | null = null;

/** Notify renderer about browser-use steps (for UI timeline). */
function notifyBrowserStep(command: string, params: Record<string, any>, result: string) {
  const { BrowserWindow: BW } = require('electron');
  const allWindows = BW.getAllWindows();
  const mainWindow = allWindows.find((w: any) => w.getTitle()?.includes('DSME')) || allWindows[0];
  if (!mainWindow) return;

  mainWindow.webContents.send('browser-step', {
    command,
    sessionTitle: activeSessionTitle,
    params,
    result,
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
  const result = await browserViewManager.navigate(url);
  notifyBrowserStep('navigate', { url }, result);
  // Auto-wait for page to settle after navigation (3s initial idle check)
  await browserViewManager.waitForIdle(5000);
  return result;
}

/** Get a text snapshot of the current page. */
export async function browserSnapshot(): Promise<string> {
  const result = await browserViewManager.executeJS(SNAPSHOT_SCRIPT);
  notifyBrowserStep('snapshot', {}, `${result.split('\\n').length} lines`);
  return result;
}

/** Click element by ref. Auto-waits for idle after click. */
export async function browserClick(ref: string): Promise<string> {
  const result = await browserViewManager.executeJS(clickScript(ref));
  notifyBrowserStep('click', { ref }, result);
  // If click succeeded, wait for page to settle (navigation, AJAX, DOM changes)
  if (!result.startsWith('Error:')) {
    const idleStatus = await browserViewManager.waitForIdle(8000);
    return result + ` [${idleStatus}]`;
  }
  return result;
}

/** Type into element by ref using native Electron insertText. Auto-waits for idle after input. */
export async function browserType(ref: string, text: string): Promise<string> {
  // Step 1: JS focuses the element and selects existing content
  const focusResult = await browserViewManager.executeJS(focusAndSelectAllScript(ref));
  if (focusResult.startsWith('Error:')) {
    notifyBrowserStep('type', { ref, text }, focusResult);
    return focusResult;
  }
  // Step 2: Chromium-native text insertion (bypasses TrustedHTML, triggers all framework listeners)
  const insertResult = await browserViewManager.insertText(text);
  const result = `${focusResult} → ${insertResult}`;
  notifyBrowserStep('type', { ref, text }, result);
  // Brief wait after typing (autocomplete, validation)
  await browserViewManager.waitForIdle(3000);
  return result;
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

/** Scroll page. */
export async function browserScroll(direction: 'up' | 'down'): Promise<string> {
  const result = await browserViewManager.executeJS(scrollScript(direction));
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
  if (result.length > 5000 && /^data:[a-z]+\/[a-z]+;base64,/i.test(result)) {
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
  const { BrowserWindow: BW } = require('electron');
  const allWindows = BW.getAllWindows();
  const mainWindow = allWindows.find((w: any) => w.getTitle()?.includes('DSME')) || allWindows[0];
  if (mainWindow) {
    mainWindow.webContents.send('browser-panel-open');
  }
}
