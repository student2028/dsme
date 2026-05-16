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
 * The view is attached as a child of the main BrowserWindow's contentView
 * and positioned via setBounds() — the renderer sends resize/position updates
 * through the 'browser-view-bounds' IPC channel.
 */

import { WebContentsView, BrowserWindow, session } from 'electron';

export class BrowserViewManager {
  private view: WebContentsView | null = null;
  private mainWindow: BrowserWindow | null = null;
  private visible = false;
  private currentUrl = '';
  private bounds = { x: 0, y: 0, width: 0, height: 0 };

  /** Call once after the main BrowserWindow is created. */
  init(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;

    // Use a separate persistent session so we don't pollute the app's own cookies
    const browserSession = session.fromPartition('persist:browser-panel');

    this.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        session: browserSession,
        // No node integration — this is a plain browser view
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    // Set a standard Chrome UA
    this.view.webContents.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );

    // Add to window but initially hidden (zero bounds)
    this.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    mainWindow.contentView.addChildView(this.view);

    // Notify renderer on navigation events (URL bar, loading status)
    this.view.webContents.on('did-navigate', (_e, url) => {
      this.currentUrl = url;
      this.notifyRenderer('browser-view-navigated', {
        url,
        title: this.view!.webContents.getTitle(),
      });
    });
    this.view.webContents.on('did-navigate-in-page', (_e, url) => {
      this.currentUrl = url;
      this.notifyRenderer('browser-view-navigated', {
        url,
        title: this.view!.webContents.getTitle(),
      });
    });

    console.log('[BrowserViewManager] Initialized with WebContentsView');
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
    try {
      await this.view.webContents.loadURL(url);
      this.currentUrl = url;
      const title = this.view.webContents.getTitle();
      this.notifyRenderer('browser-view-navigated', { url, title });
      return `Navigated to ${url}. Title: ${title}`;
    } catch (e: any) {
      // ERR_ABORTED is common for redirects / resource loads — page may still be usable
      if (e.message?.includes('ERR_ABORTED')) {
        const title = this.view.webContents.getTitle();
        return `Navigated to ${url} (with redirect). Title: ${title}`;
      }
      return `Navigation error: ${e.message}`;
    }
  }

  async goBack(): Promise<string> {
    if (!this.view) return 'Error: view not initialized';
    if (!this.view.webContents.canGoBack()) return 'Cannot go back — no history.';
    this.view.webContents.goBack();
    // Wait a bit for navigation to complete
    await new Promise(r => setTimeout(r, 1500));
    const url = this.view.webContents.getURL();
    this.currentUrl = url;
    this.notifyRenderer('browser-view-navigated', { url, title: this.view.webContents.getTitle() });
    return `Went back. Now at: ${url}`;
  }

  // ── Script execution (ZERO IPC — main process direct) ──

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
        return (
          '[evaluate: undefined/null] Electron cannot pass non-JSON-serializable values. ' +
          'Do not return DOM nodes, PerformanceEntry objects, or Map/Set. ' +
          'Return JSON.stringify(...) instead.'
        );
      }
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (e: any) {
      return `Script error: ${e.message}`;
    }
  }

  // ── Visibility & bounds ──

  setBounds(bounds: { x: number; y: number; width: number; height: number }) {
    this.bounds = bounds;
    if (this.visible && this.view) {
      this.view.setBounds(bounds);
    }
  }

  show(bounds?: { x: number; y: number; width: number; height: number }) {
    if (bounds) this.bounds = bounds;
    this.visible = true;
    if (this.view) {
      this.view.setBounds(this.bounds);
    }
  }

  hide() {
    this.visible = false;
    if (this.view) {
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
