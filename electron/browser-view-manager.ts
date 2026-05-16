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

    // Override navigator.userAgentData in page context (Google checks this)
    this.view.webContents.on('dom-ready', () => {
      this.view?.webContents.executeJavaScript(`
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
              uaFullVersion: "${CHROME_VERSION}.0.0.0"
            })
          },
          configurable: true
        });
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

  // ── Navigation ──

  async navigate(url: string): Promise<string> {
    if (!this.view) return 'Error: view not initialized';
    this.ensureAttached();
    try {
      await this.view.webContents.loadURL(url);
      this.currentUrl = url;
      const title = this.view.webContents.getTitle();
      this.notifyRenderer('browser-view-navigated', { url, title });
      return `Navigated to ${url}. Title: ${title}`;
    } catch (e: any) {
      if (e.message?.includes('ERR_ABORTED')) {
        const title = this.view.webContents.getTitle();
        return `Navigated to ${url} (with redirect). Title: ${title}`;
      }
      return `Navigation error: ${e.message}`;
    }
  }

  async goBack(): Promise<string> {
    if (!this.view) return 'Error: view not initialized';
    const nav = this.view.webContents.navigationHistory;
    if (!nav.canGoBack()) return 'Cannot go back — no history.';
    nav.goBack();
    await new Promise(r => setTimeout(r, 1500));
    const url = this.view.webContents.getURL();
    this.currentUrl = url;
    this.notifyRenderer('browser-view-navigated', { url, title: this.view.webContents.getTitle() });
    return `Went back. Now at: ${url}`;
  }

  // ── Script execution ──

  async executeJS(script: string, timeoutMs = 115_000): Promise<string> {
    if (!this.view) return 'Error: view not initialized';
    try {
      const result = await Promise.race([
        this.view.webContents.executeJavaScript(script),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs),
        ),
      ]);
      if (result === null || result === undefined) {
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
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (e: any) {
      return `Script error: ${e.message}`;
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
