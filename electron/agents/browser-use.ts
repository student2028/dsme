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
 *   browser_click(ref)      — click element by ref
 *   browser_type(ref, text) — type into element
 *   browser_scroll(dir)     — scroll page
 *   browser_back()          — go back
 *   browser_eval(script)    — run arbitrary JS in page context
 */

import { browserViewManager } from '../browser-view-manager';

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
    return t.trim().replace(/\\s+/g, ' ').slice(0, 80);
  }

  // Page metadata
  lines.push('Page: ' + document.title);
  lines.push('URL: ' + location.href);
  lines.push('');

  // Walk interactive elements
  const interactives = document.querySelectorAll('a, button, input, textarea, select, [role="button"], img, h1, h2, h3, h4, h5, h6, p, li');
  for (const el of interactives) {
    if (!isVisible(el)) continue;
    if (seen.has(el)) continue;

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || '';

    // Interactive elements
    if (tag === 'a' && el.href) {
      const ref = assignRef(el);
      const text = getText(el) || getLabel(el) || el.href;
      lines.push('[' + ref + '] link "' + text.slice(0, 60) + '"');
      seen.add(el);
    }
    else if (tag === 'button' || role === 'button' || (tag === 'input' && (el.type === 'button' || el.type === 'submit'))) {
      const ref = assignRef(el);
      const text = getText(el) || getLabel(el) || el.value || 'button';
      lines.push('[' + ref + '] button "' + text.slice(0, 60) + '"');
      seen.add(el);
    }
    else if (tag === 'input' && el.type !== 'hidden') {
      const ref = assignRef(el);
      const label = getLabel(el) || el.name || el.type;
      const val = el.value ? ' value="' + el.value.slice(0, 40) + '"' : '';
      lines.push('[' + ref + '] input[' + (el.type || 'text') + '] "' + label + '"' + val);
      seen.add(el);
    }
    else if (tag === 'textarea') {
      const ref = assignRef(el);
      const label = getLabel(el) || el.name || 'textarea';
      const val = el.value ? ' value="' + el.value.slice(0, 40) + '"' : '';
      lines.push('[' + ref + '] textarea "' + label + '"' + val);
      seen.add(el);
    }
    else if (tag === 'select') {
      const ref = assignRef(el);
      const label = getLabel(el) || el.name || 'select';
      const selected = el.selectedOptions?.[0]?.text || '';
      lines.push('[' + ref + '] select "' + label + '" selected="' + selected.slice(0, 30) + '"');
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
  return lines.slice(0, 150).join('\\n');
})()`;

// ── Click by ref ──
function clickScript(ref: string): string {
  return `(function() {
    try {
      const el = document.querySelector('[data-dsme-ref="${ref}"]');
      if (!el) return 'Error: element [${ref}] not found. Run browser_snapshot to get current refs.';
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.click();
      return 'Clicked [${ref}]: ' + (el.innerText || el.tagName).slice(0, 50);
    } catch (e) {
      return 'Error clicking [${ref}]: ' + e.message;
    }
  })()`;
}

// ── Type into element by ref ──
function typeScript(ref: string, text: string): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
  return `(function() {
    try {
      const el = document.querySelector('[data-dsme-ref="${ref}"]');
      if (!el) return 'Error: element [${ref}] not found. Run browser_snapshot to get current refs.';
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus();
      el.value = '${escaped}';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'Typed into [${ref}]: "${escaped.slice(0, 30)}"';
    } catch (e) {
      return 'Error typing into [${ref}]: ' + e.message;
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

/** Navigate to URL — directly via WebContentsView. */
export async function browserNavigate(url: string): Promise<string> {
  // Ensure browser panel is visible in the UI
  ensureBrowserPanelOpen();
  const result = await browserViewManager.navigate(url);
  notifyBrowserStep('navigate', { url }, result);
  return result;
}

/** Get a text snapshot of the current page. */
export async function browserSnapshot(): Promise<string> {
  const result = await browserViewManager.executeJS(SNAPSHOT_SCRIPT);
  notifyBrowserStep('snapshot', {}, `${result.split('\n').length} lines`);
  return result;
}

/** Click element by ref. */
export async function browserClick(ref: string): Promise<string> {
  const result = await browserViewManager.executeJS(clickScript(ref));
  notifyBrowserStep('click', { ref }, result);
  return result;
}

/** Type into element by ref. */
export async function browserType(ref: string, text: string): Promise<string> {
  const result = await browserViewManager.executeJS(typeScript(ref, text));
  notifyBrowserStep('type', { ref, text }, result);
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
  return result;
}

/** Run arbitrary JS in page context. */
export async function browserEval(script: string): Promise<string> {
  const result = await browserViewManager.executeJS(script);
  notifyBrowserStep('eval', { script: script.slice(0, 200) }, result.slice(0, 500));
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
