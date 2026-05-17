/**
 * DSME BrowserViewManager — WebContentsView-based browser panel
 *
 * Replaces the renderer-process <webview> with a main-process WebContentsView.
 * This provides:
 *   - Zero-IPC script execution (main process → webContents directly)
 *   - Stable lifecycle (independent of renderer re-renders / HMR)
 *   - Native View layer compositing (no GuestView overhead)
 *   - Future-proof (webview tag deprecated by Electron)
 *
 * IMPORTANT: The view is NOT attached to the window at init time.
 * It is deferred until the first navigate() or show() call.
 * This prevents a Chromium-level SIGSEGV (rust_bmp decoder null pointer)
 * that occurs when an idle WebContentsView participates in macOS
 * NSApplication event routing (e.g. right-click anywhere in the window).
 */

import { WebContentsView, BrowserWindow, session } from 'electron';

export class BrowserViewManager {
  private view: WebContentsView | null = null;
  private mainWindow: BrowserWindow | null = null;
  private visible = false;
  private attached = false;
  private currentUrl = '';
  private bounds = { x: 0, y: 0, width: 0, height: 0 };

  /** Call once after the main BrowserWindow is created. */
  init(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;

    const browserSession = session.fromPartition('persist:browser-panel');

    this.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        session: browserSession,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false, // Allow file:// to load other local files directly
      },
    });

    const CHROME_VERSION = '131';
    const CHROME_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`;

    this.view.webContents.setUserAgent(CHROME_UA);

    // Spoof Chrome Client Hints so Google doesn't block sign-in
    browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
      details.requestHeaders['sec-ch-ua'] = `"Google Chrome";v="${CHROME_VERSION}", "Chromium";v="${CHROME_VERSION}", "Not_A Brand";v="24"`;
      details.requestHeaders['sec-ch-ua-mobile'] = '?0';
      details.requestHeaders['sec-ch-ua-platform'] = '"macOS"';
      callback({ requestHeaders: details.requestHeaders });
    });

    // Automatically handle downloads to prevent the system "Save As" dialog
    browserSession.on('will-download', (event, item, webContents) => {
      const os = require('node:os');
      const path = require('node:path');
      // Save directly to the user's Downloads folder
      const downloadPath = path.join(os.homedir(), 'Downloads', item.getFilename());
      item.setSavePath(downloadPath);
      
      console.log(`[BrowserViewManager] Started auto-download: ${downloadPath}`);
      
      item.once('done', (event, state) => {
        if (state === 'completed') {
          console.log(`[BrowserViewManager] Download successfully completed: ${downloadPath}`);
        } else {
          console.error(`[BrowserViewManager] Download failed with state: ${state}`);
        }
      });
    });

    // Full Chrome environment spoofing for Google sign-in compatibility.
    // Google checks: userAgentData, window.chrome, navigator.plugins, Electron globals.
    this.view.webContents.on('dom-ready', () => {
      this.view?.webContents.executeJavaScript(`
        // 1. navigator.userAgentData
        try {
          Object.defineProperty(navigator, 'userAgentData', {
            value: {
              brands: [
                { brand: "Google Chrome", version: "${CHROME_VERSION}" },
                { brand: "Chromium", version: "${CHROME_VERSION}" },
                { brand: "Not_A Brand", version: "24" }
              ],
              mobile: false,
              platform: "macOS",
              getHighEntropyValues: () => Promise.resolve({
                architecture: "arm",
                model: "",
                platform: "macOS",
                platformVersion: "15.0.0",
                uaFullVersion: "${CHROME_VERSION}.0.0.0",
                fullVersionList: [
                  { brand: "Google Chrome", version: "${CHROME_VERSION}.0.0.0" },
                  { brand: "Chromium", version: "${CHROME_VERSION}.0.0.0" }
                ]
              })
            },
            configurable: true
          });
        } catch {}

        // 2. window.chrome (Google checks its existence + shape)
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) {
          window.chrome.runtime = {
            connect: () => {},
            sendMessage: () => {},
            id: undefined
          };
        }
        window.chrome.csi = () => ({});
        window.chrome.loadTimes = () => ({});

        // 3. navigator.plugins — Chrome always has at least these
        try {
          Object.defineProperty(navigator, 'plugins', {
            get: () => [
              { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
              { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
              { name: 'Native Client', filename: 'internal-nacl-plugin' }
            ]
          });
        } catch {}

        // 4. Remove Electron fingerprints
        try {
          delete window.process;
          delete window.require;
          delete window.module;
          delete window.exports;
          delete window.__electron_preload;
        } catch {}

        // 5. navigator.webdriver (Google checks automation detection)
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        } catch {}
      `).catch(() => {});
    });

    // DO NOT addChildView here — defer until first show/navigate.
    this.attached = false;

    // Notify renderer on navigation events
    this.view.webContents.on('did-navigate', (_e, url) => {
      this.currentUrl = url;
      this.notifyRenderer('browser-view-navigated', { url, title: this.view!.webContents.getTitle() });
    });
    this.view.webContents.on('did-navigate-in-page', (_e, url) => {
      this.currentUrl = url;
      this.notifyRenderer('browser-view-navigated', { url, title: this.view!.webContents.getTitle() });
    });

    // Intercept window.open() — navigate in-place
    this.view.webContents.setWindowOpenHandler(({ url }) => {
      if (url && url.startsWith('http')) {
        this.view!.webContents.loadURL(url);
      }
      return { action: 'deny' as const };
    });

    // Suppress right-click context menu
    this.view.webContents.on('context-menu', (event) => {
      event.preventDefault();
    });

    // Auto-recover from renderer crashes
    this.view.webContents.on('render-process-gone', (_event, details) => {
      console.error('[BrowserViewManager] Renderer crashed:', details.reason, details.exitCode);
      this.recreateView();
    });

    console.log('[BrowserViewManager] Initialized with WebContentsView (deferred attach)');
  }

  /** Attach the view to the main window on first use. */
  private ensureAttached() {
    if (this.attached || !this.view || !this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    this.mainWindow.contentView.addChildView(this.view);
    this.attached = true;
    console.log('[BrowserViewManager] View attached to window');
  }

  /** Ensure the view and its webContents are alive; recreate if needed. Returns false if unrecoverable. */
  private ensureHealthyView(): boolean {
    if (!this.view) return false;
    if (!this.view.webContents || this.view.webContents.isDestroyed()) {
      this.recreateView();
      if (!this.view || !this.view.webContents) return false;
    }
    return true;
  }

  /** Recreate the view after a renderer crash. */
  private recreateView() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    try {
      if (this.view && this.attached) {
        this.mainWindow.contentView.removeChildView(this.view);
      }
      if (this.view) {
        try { this.view.webContents.close(); } catch {}
      }
    } catch {}
    console.log('[BrowserViewManager] Recreating view...');
    this.view = null;
    this.attached = false;
    this.init(this.mainWindow);
  }

  /** Clean up on app quit. */
  destroy() {
    if (this.view) {
      try { this.view.webContents.close(); } catch {}
      this.view = null;
    }
  }

  // ── HTML Rendering ──

  /** Render HTML content by writing to a temp file and loading it.
   *  This avoids data: URL issues (length limits, encoding bugs) that cause
   *  raw text to display instead of rendered HTML. */
  async loadHTML(html: string): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    this.ensureAttached();
    const fsP = require('node:fs/promises');
    const os = require('node:os');
    const path = require('node:path');
    const tmpFile = path.join(os.tmpdir(), `dsme-render-${Date.now()}.html`);
    try {
      await fsP.writeFile(tmpFile, html, 'utf8');
      await this.view!.webContents.loadFile(tmpFile);
      this.currentUrl = `file://${tmpFile}`;
      const title = this.view!.webContents.getTitle();
      this.notifyRenderer('browser-view-navigated', { url: this.currentUrl, title });
      // Clean up temp file after a delay (page is already loaded in memory)
      setTimeout(() => fsP.unlink(tmpFile).catch(() => {}), 5000);
      return `HTML rendered successfully. Title: ${title}`;
    } catch (e: any) {
      return `HTML render error: ${e.message}`;
    }
  }

  // ── Navigation ──

  async navigate(url: string, _retryCount = 0): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    this.ensureAttached();
    try {
      await this.view!.webContents.loadURL(url);
      this.currentUrl = url;
      const title = this.view!.webContents.getTitle();
      this.notifyRenderer('browser-view-navigated', { url, title });
      return `Navigated to ${url}. Title: ${title}`;
    } catch (e: any) {
      if (e.message?.includes('ERR_ABORTED')) {
        try {
          const title = this.view!.webContents.getTitle();
          return `Navigated to ${url} (with redirect). Title: ${title}`;
        } catch {
          return `Navigated to ${url} (with redirect).`;
        }
      }
      
      // Native WebContents in a bad state — recreate and retry once.
      if (_retryCount < 1 && (e.message?.includes('Cannot read properties') || e.message?.includes('object has been destroyed'))) {
        console.error('[BrowserViewManager] WebContents in bad state, recreating and retrying...', e.message);
        this.recreateView();
        return this.navigate(url, _retryCount + 1);
      }
      
      return `Navigation error: ${e.message}`;
    }
  }

  async goBack(): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    try {
      const nav = this.view!.webContents.navigationHistory;
      if (!nav.canGoBack()) return 'Cannot go back — no history.';
      nav.goBack();
      await new Promise(r => setTimeout(r, 1500));
      const url = this.view!.webContents.getURL();
      this.currentUrl = url;
      this.notifyRenderer('browser-view-navigated', { url, title: this.view!.webContents.getTitle() });
      return `Went back. Now at: ${url}`;
    } catch (e: any) {
      return `GoBack error: ${e.message}`;
    }
  }

  // ── Page idle detection ──

  /**
   * Wait until the page appears idle:
   *  1. No pending XHR/fetch (detected via Performance Observer / PerformanceResourceTiming)
   *  2. No loading spinners / progress bars / aria-busy elements
   *  3. DOM text content is stable for 2 consecutive checks
   *
   * Returns a status string describing what it observed.
   * Timeout: maxWaitMs (default 15s). Never throws.
   */
  async waitForIdle(maxWaitMs = 15_000): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    const POLL_INTERVAL = 800;
    const STABLE_CHECKS_NEEDED = 2;

    const idleScript = `(async () => {
      const maxWait = ${maxWaitMs};
      const pollInterval = ${POLL_INTERVAL};
      const stableNeeded = ${STABLE_CHECKS_NEEDED};
      const start = Date.now();
      let stableCount = 0;
      let lastTextHash = '';

      function simpleHash(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
        return String(h);
      }

      function hasLoadingIndicators() {
        // Common loading patterns across web apps
        const selectors = [
          '[aria-busy="true"]',
          '.loading', '.spinner', '.skeleton',
          'mat-progress-spinner', 'mat-progress-bar',
          '[role="progressbar"]',
          '.generating', '.thinking',
          '[data-loading="true"]',
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) return sel;
        }
        return null;
      }

      while (Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, pollInterval));

        const loadingSel = hasLoadingIndicators();
        if (loadingSel) {
          stableCount = 0;
          continue;
        }

        // Check DOM text stability
        const textNow = simpleHash((document.body?.innerText || '').slice(0, 5000));
        if (textNow === lastTextHash && textNow !== '0') {
          stableCount++;
        } else {
          stableCount = 0;
        }
        lastTextHash = textNow;

        if (stableCount >= stableNeeded) {
          return 'idle: page stable for ' + (stableNeeded * pollInterval) + 'ms after ' + (Date.now() - start) + 'ms';
        }
      }

      const loadingSel = hasLoadingIndicators();
      if (loadingSel) {
        return 'timeout: page still loading (' + loadingSel + ') after ' + maxWait + 'ms';
      }
      return 'timeout: DOM not stable after ' + maxWait + 'ms';
    })()`;

    try {
      const result = await Promise.race([
        this.view!.webContents.executeJavaScript(idleScript),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve(`timeout: hard timeout after ${maxWaitMs}ms`), maxWaitMs + 2000),
        ),
      ]);
      return typeof result === 'string' ? result : String(result);
    } catch (e: any) {
      return `waitForIdle error: ${e.message}`;
    }
  }

  // ── Script execution ──

  async executeJS(script: string, timeoutMs = 600_000): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    try {
      const wrappedScript = `(async () => {
        try {
          const res = await (async () => {
            ${script}
          })();
          return { ok: true, value: res };
        } catch (e) {
          return { ok: false, error: e.stack || e.message || String(e) };
        }
      })()`;
      const result = await Promise.race([
        this.view.webContents.executeJavaScript(wrappedScript),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs),
        ),
      ]);
      if (!result.ok) {
        return `Script error: ${result.error}`;
      }
      
      const val = result.value;
      if (val === null || val === undefined) {
        try {
          const fallback = await this.view.webContents.executeJavaScript(
            `document.body?.innerText?.slice(0, 8000) || ''`
          );
          if (fallback && typeof fallback === 'string' && fallback.length > 10) {
            return fallback;
          }
        } catch {}
        return 'Script completed but returned no value. Use `return` to return data.';
      }
      return typeof val === 'string' ? val : JSON.stringify(val);
    } catch (e: any) {
      return `Script error: ${e.message}`;
    }
  }

  // ── Native input (engine-level, bypasses TrustedHTML / CSP) ──

  /**
   * Insert text at the currently focused element using Chromium's native input path.
   * This is equivalent to a human typing — all framework event listeners fire naturally.
   * Works with contenteditable, input, textarea, and rich text editors (Quill, ProseMirror, etc.).
   * Handles CJK (Chinese/Japanese/Korean) characters natively via IME passthrough.
   */
  async insertText(text: string): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    try {
      await this.view!.webContents.insertText(text);
      return `Inserted ${text.length} characters`;
    } catch (e: any) {
      return `insertText error: ${e.message}`;
    }
  }

  /**
   * Send a native keyboard event (Enter, Tab, Escape, Backspace, etc.).
   * This fires at the Chromium engine level — identical to a physical key press.
   * Supported keys: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, etc.
   */
  async pressKey(key: string): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    try {
      // Map common key names to Electron Accelerator key codes
      // Ref: https://www.electronjs.org/docs/latest/api/accelerator
      const keyMap: Record<string, string> = {
        'Enter':     'Return',
        'Tab':       'Tab',
        'Escape':    'Escape',
        'Backspace': 'Backspace',
        'Delete':    'Delete',
        'ArrowUp':   'Up',
        'ArrowDown': 'Down',
        'ArrowLeft': 'Left',
        'ArrowRight':'Right',
        'Space':     'Space',
      };
      const keyCode = keyMap[key];
      if (!keyCode) {
        return `Error: unsupported key "${key}". Supported: ${Object.keys(keyMap).join(', ')}`;
      }
      const wc = this.view!.webContents;
      // Only keyDown + keyUp — no 'char' event.
      // pressKey is for control actions (submit, dismiss, navigate), not character input.
      wc.sendInputEvent({ type: 'keyDown', keyCode } as any);
      wc.sendInputEvent({ type: 'keyUp', keyCode } as any);
      return `Pressed key: ${key}`;
    } catch (e: any) {
      return `pressKey error: ${e.message}`;
    }
  }

  // ── Visibility & bounds ──

  setBounds(bounds: { x: number; y: number; width: number; height: number }) {
    this.bounds = bounds;
    if (this.visible && this.view && this.attached) {
      this.view.setBounds(bounds);
    }
  }

  show(bounds?: { x: number; y: number; width: number; height: number }) {
    if (bounds) this.bounds = bounds;
    this.visible = true;
    if (this.view) {
      this.ensureAttached();
      this.view.setBounds(this.bounds);
    }
  }

  hide() {
    this.visible = false;
    if (this.view && this.attached) {
      this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
  }

  // ── Getters ──

  getUrl(): string {
    return this.view?.webContents.getURL() || this.currentUrl || '';
  }

  getTitle(): string {
    return this.view?.webContents.getTitle() || '';
  }

  isVisible(): boolean {
    return this.visible;
  }

  // ── Internal ──

  private notifyRenderer(channel: string, data: any) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}

/** Singleton — imported by browser-use.ts, browser.ts, main.ts */
export const browserViewManager = new BrowserViewManager();
