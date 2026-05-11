/**
 * DSME Browser-Use — Long-running browser agent tools
 *
 * Uses Electron webview's executeJavaScript() for zero-distance DOM operations.
 * No CDP, no WebSocket, no external process — the webview IS the browser.
 *
 * Tool set:
 *   browser_navigate(url)   — navigate to URL
 *   browser_snapshot()      — get page snapshot with interactive element refs
 *   browser_click(ref)      — click element by ref
 *   browser_type(ref, text) — type into element
 *   browser_scroll(dir)     — scroll page
 *   browser_back()          — go back
 *   browser_eval(script)    — run arbitrary JS in page context
 */

// ── Snapshot JS — runs inside the webview page context ──
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

// ── IPC command sender — shared by all tools ──
function sendBrowserCommand(
  command: string,
  params: Record<string, any> = {},
  timeoutMs = 30000,
): Promise<string> {
  const { BrowserWindow: BW, ipcMain } = require('electron');
  const allWindows = BW.getAllWindows();
  const mainWindow = allWindows.find((w: any) => w.getTitle()?.includes('DSME')) || allWindows[0];
  if (!mainWindow) return Promise.resolve('Error: no main window');

  return new Promise<string>((resolve) => {
    const id = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const timeoutId = setTimeout(() => {
      ipcMain.removeAllListeners(`browser-result-${id}`);
      resolve(`Error: browser command timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    ipcMain.once(`browser-result-${id}`, (_: any, result: string) => {
      clearTimeout(timeoutId);
      resolve(result);
    });

    mainWindow.webContents.send('browser-command', { id, command, ...params });
  });
}

// ── Exported tool functions (called by the agent) ──

export async function browserNavigate(url: string): Promise<string> {
  return sendBrowserCommand('navigate', { url });
}

export async function browserSnapshot(): Promise<string> {
  return sendBrowserCommand('snapshot', { script: SNAPSHOT_SCRIPT });
}

export async function browserClick(ref: string): Promise<string> {
  return sendBrowserCommand('eval', { script: clickScript(ref) });
}

export async function browserType(ref: string, text: string): Promise<string> {
  return sendBrowserCommand('eval', { script: typeScript(ref, text) });
}

export async function browserScroll(direction: 'up' | 'down'): Promise<string> {
  return sendBrowserCommand('eval', { script: scrollScript(direction) });
}

export async function browserBack(): Promise<string> {
  return sendBrowserCommand('back');
}

export async function browserEval(script: string): Promise<string> {
  return sendBrowserCommand('eval', { script });
}
