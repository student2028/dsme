/**
 * DSME BrowserViewManager — AI Agent as the Browser Itself
 *
 * DESIGN PHILOSOPHY:
 *   Traditional browser automation (Playwright, Puppeteer) treats the browser
 *   as a remote target — connecting via WebSocket CDP to control it from outside.
 *   DSME takes a fundamentally different approach: the AI agent lives INSIDE
 *   the browser's main process. There is no "remote control" — we ARE the browser.
 *
 * This gives us three layers of capability, from most to least intimate:
 *
 *   1. Electron Native (exclusive to us):
 *      - sendInputEvent(): engine-level mouse/keyboard, identical to physical HID
 *      - insertText(): IME-level text insertion, bypasses all JS interception
 *      - WebFrameMain.executeJavaScript(): privileged cross-origin JS execution
 *      - WebContentsView lifecycle: crash recovery, process management
 *
 *   2. CDP as a read-only query layer (via webContents.debugger):
 *      - Accessibility.getFullAXTree(): semantic page understanding
 *      - DOM.getContentQuads(): precise element coordinates
 *      - DOM.scrollIntoViewIfNeeded(): viewport management
 *      - Page.getFrameTree(): cross-origin frame discovery
 *      Note: CDP here is in-process (zero latency), not over WebSocket.
 *
 *   3. JS injection (legacy fallback, being phased out):
 *      - executeJavaScript() for data extraction when CDP doesn't expose it
 *      - Should only be used for reads, never for interaction
 *
 * The result: AI ↔ Browser with zero distance. No IPC, no serialization,
 * no connection drops, no same-origin restrictions. The most intimate
 * coupling between an AI agent and a web browser possible.
 */

import { WebContentsView, BrowserWindow, session, WebFrameMain, clipboard } from 'electron';

export class BrowserViewManager {
  private view: WebContentsView | null = null;
  private mainWindow: BrowserWindow | null = null;
  private visible = false;
  private attached = false;
  private currentUrl = '';
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  /** When set, executeJS/insertText/pressKey operate on this subframe instead of mainFrame. */
  private targetFrame: WebFrameMain | null = null;

  // ── Electron Native state ──
  /** Timestamp of last network activity (request sent, response received, etc.) */
  private lastNetworkActivity = 0;
  /** Ring buffer of recent console errors/warnings from the page. */
  private consoleErrors: { level: string; message: string; time: number }[] = [];
  private readonly MAX_CONSOLE_ERRORS = 10;
  /** Live page title tracked via page-title-updated event (Electron Native). */
  private currentTitle = '';

  // ── CDP (read-only query layer) state ──
  private cdpAttached = false;
  /** Maps short refs (e1, e2, ...) to CDP backendDOMNodeId for interaction. */
  private refMap = new Map<string, number>();
  /**
   * Maps short refs to human-readable labels from the AX snapshot.
   * Eliminates the extra DOM.describeNode round-trip in getElementCenterByCDP.
   */
  private refLabels = new Map<string, string>();

  // ── Static constants (defined once, not rebuilt per call) ──
  private static readonly INTERACTIVE_ROLES = new Set([
    'textbox', 'button', 'link', 'combobox', 'listbox',
    'checkbox', 'radio', 'slider', 'searchbox', 'menuitem',
    'tab', 'switch', 'spinbutton', 'option', 'menuitemcheckbox',
    'menuitemradio', 'treeitem',
  ]);

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

    // ── Network activity tracking (Electron Native — no CDP, no JS injection) ──
    // Pure observation listeners that track when any HTTP activity occurs.
    // Used by waitForIdle() to know when the network is truly quiet.
    const trackNetworkActivity = () => { this.lastNetworkActivity = Date.now(); };
    browserSession.webRequest.onSendHeaders(trackNetworkActivity);        // request sent
    browserSession.webRequest.onResponseStarted(trackNetworkActivity);    // first byte received
    browserSession.webRequest.onCompleted(trackNetworkActivity);          // request completed
    browserSession.webRequest.onErrorOccurred(trackNetworkActivity);      // request failed

    // Automatically handle downloads to prevent the system "Save As" dialog
    browserSession.removeAllListeners('will-download'); // Prevent leak on recreateView
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

    // ── Permission Auto-Grant (Electron Native) ──
    // Browser permission dialogs (geolocation, camera, notifications, clipboard-read)
    // would block the agent the same way alert() dialogs do.
    // Auto-grant everything — the agent is an automation tool, not a human user.
    browserSession.setPermissionRequestHandler((_wc, permission, callback) => {
      console.log(`[BrowserViewManager] Auto-granted permission: ${permission}`);
      callback(true);
    });

    // ── Login State Monitoring (Electron Native) ──
    // When a site deletes auth cookies (logout/session expire), the agent
    // won't know until it hits a login page and wastes steps.
    // Monitor cookie removals and push a warning into consoleErrors so the
    // agent sees it in its next snapshot and can react proactively.
    browserSession.cookies.removeAllListeners('changed'); // Prevent leak on recreateView
    browserSession.cookies.on('changed', (_event: any, cookie: any, cause: string, removed: boolean) => {
      if (removed && cause !== 'overwrite') {
        // Only warn about cookies that smell like auth tokens
        const name = (cookie.name || '').toLowerCase();
        const isAuthCookie = /sess|token|auth|login|sid|jwt|csrf|_id|account/i.test(name);
        if (isAuthCookie) {
          const domain = cookie.domain || '';
          console.warn(`[BrowserViewManager] Auth cookie removed: ${cookie.name} @ ${domain} (cause: ${cause})`);
          this.consoleErrors.push({
            level: 'warn',
            message: `Auth cookie "${cookie.name}" removed from ${domain} (${cause}) — possible logout/session expire`,
            time: Date.now(),
          });
        }
      }
    });

    // ── Certificate Error Bypass (Electron Native) ──
    // Self-signed/expired certs on internal sites would cause ERR_CERT_AUTHORITY_INVALID.
    // The agent needs to access whatever URL it's told to — bypass silently.
    browserSession.setCertificateVerifyProc((_request, callback) => {
      callback(0); // 0 = success, accept all certificates
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

        // 6. Auto-handle JS dialogs — prevent alert/confirm/prompt from blocking Agent.
        // These are intercepted at the page JS level, so no native dialog appears.
        // The original messages are logged to console for debugging visibility.
        window.alert = (msg) => { console.warn('[DSME] Suppressed alert:', msg); };
        window.confirm = (msg) => { console.warn('[DSME] Auto-confirmed:', msg); return true; };
        window.prompt = (msg, def) => { console.warn('[DSME] Auto-dismissed prompt:', msg); return def || ''; };
      `).catch(() => {});
    });

    // DO NOT addChildView here — defer until first show/navigate.
    this.attached = false;

    // Notify renderer on navigation events & invalidate CDP refs
    this.view.webContents.on('did-navigate', (_e, url) => {
      this.currentUrl = url;
      this.refMap.clear();   // Old backendDOMNodeIds are invalid after navigation
      this.refLabels.clear(); // Labels are stale too
      // Cross-origin navigation may destroy the old renderer process,
      // silently invalidating CDP. Reset so ensureCDP() re-attaches on next use.
      this.cdpAttached = false;
      const title = this.view!.webContents.getTitle();
      this.currentTitle = title;
      this.notifyRenderer('browser-view-navigated', { url, title });
      // Clear any visual overlay — stale boxes from the previous page would
      // appear frozen over the new page content.
      this.clearOverlay().catch(() => {});
    });
    this.view.webContents.on('did-navigate-in-page', (_e, url) => {
      this.currentUrl = url;
      // SPA routing may change visible elements — stale refs could cause mis-clicks
      this.refMap.clear();
      this.refLabels.clear();
      const title = this.view!.webContents.getTitle();
      this.currentTitle = title;
      this.notifyRenderer('browser-view-navigated', { url, title });
      // Clear overlay — SPA route change renders new content, old boxes are wrong
      this.clearOverlay().catch(() => {});
    });

    // Track live page title updates (Electron Native — no polling needed)
    // SPAs like Gmail update the title to show unread count (e.g. "(3) Gmail").
    // Without this, getTitle() would return the stale initial title.
    this.view.webContents.on('page-title-updated', (_e, title) => {
      this.currentTitle = title;
    });

    // Intercept window.open() — navigate in-place
    this.view.webContents.setWindowOpenHandler(({ url }) => {
      if (url && url.startsWith('http')) {
        this.targetFrame = null;  // Reset frame — new page will destroy old iframes
        this.refMap.clear();      // Old refs invalid
        this.refLabels.clear();   // Labels are stale too (Bug fix: was missing)
        this.view!.webContents.loadURL(url);
      }
      return { action: 'deny' as const };
    });

    // Suppress right-click context menu
    this.view.webContents.on('context-menu', (event) => {
      event.preventDefault();
    });

    // Bypass beforeunload dialogs — In Electron, will-prevent-unload works
    // OPPOSITE to other events: calling preventDefault() means "bypass the dialog
    // and allow navigation". Without it, the page's beforeunload would block.
    this.view.webContents.on('will-prevent-unload', (event) => {
      event.preventDefault(); // Allow navigation — suppress "Leave site?" dialog
      console.log('[BrowserViewManager] Suppressed beforeunload dialog — allowing navigation');
    });

    // ── Native dialog backstop (Electron Native) ──
    // The JS override (window.alert = ...) in dom-ready covers most dialogs,
    // but Electron can still fire native OS dialogs for very early page calls
    // or from workers. This handler catches them at the engine level.
    // Confirm/prompt auto-accept; alert auto-dismiss.
    this.view.webContents.on('dialog', (event: any, dialogInfo: any) => {
      event.preventDefault();
      if (dialogInfo.type === 'confirm' || dialogInfo.type === 'beforeunload') {
        event.defaultPrevented = true;
        this.consoleErrors.push({
          level: 'warn',
          message: `[DSME] Native ${dialogInfo.type} dialog suppressed: ${String(dialogInfo.message || '').slice(0, 100)}`,
          time: Date.now(),
        });
      }
      console.warn(`[BrowserViewManager] Native dialog suppressed: ${dialogInfo.type} — ${dialogInfo.message || ''}`);
    });

    // Auto-recover from renderer crashes
    this.view.webContents.on('render-process-gone', (_event, details) => {
      console.error('[BrowserViewManager] Renderer crashed:', details.reason, details.exitCode);
      this.recreateView();
    });

    // ── Console monitoring (Electron Native) ──
    // Captures page-level console warnings and errors in a ring buffer.
    // Agent can call getRecentErrors() to understand page issues without
    // looking at DOM or injecting error-catching scripts.
    // Levels: 0=verbose, 1=info, 2=warning, 3=error
    this.view.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) { // warning or error
        this.consoleErrors.push({
          level: level === 2 ? 'warn' : 'error',
          message: message.slice(0, 200),
          time: Date.now(),
        });
        // Ring buffer — drop oldest when full
        if (this.consoleErrors.length > this.MAX_CONSOLE_ERRORS) {
          this.consoleErrors.shift();
        }
      }
    });

    // ── Load failure detection (Electron Native) ──
    // Filter out ERR_ABORTED (-3) — fires constantly during normal redirects
    // and cancelled subresource loads. Only log real failures.
    this.view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      if (errorCode === -3) return; // ERR_ABORTED — normal during redirects, not a real error
      console.warn(`[BrowserViewManager] Load failed: ${errorDescription} (${errorCode}) for ${validatedURL}`);
      this.consoleErrors.push({
        level: 'error',
        message: `Page load failed: ${errorDescription} (code ${errorCode})`,
        time: Date.now(),
      });
    });

    // ── Background Throttling Prevention (Electron Native) ──
    // When the browser panel is behind the chat panel (or the app is minimized),
    // Chromium aggressively throttles timers, rAF, and WebSocket keepalives.
    // This causes: stale page state, expired sessions, broken real-time apps.
    // Disabling it ensures the agent's page stays "alive" even when not visible.
    this.view.webContents.setBackgroundThrottling(false);

    // ── HTTP Basic Auth Auto-Handler (Electron Native) ──
    // Internal tools often use HTTP 401 Basic Auth. Without this handler,
    // Electron shows a native OS login dialog that blocks the agent forever.
    // We auto-cancel it and log the challenge so the agent can see which
    // URL needs credentials and handle it via browser_type or cookie import.
    this.view.webContents.on('login', (event, authenticationResponseDetails, authInfo, callback) => {
      event.preventDefault();
      console.warn(`[BrowserViewManager] HTTP Basic Auth challenge from ${authInfo.host}:${authInfo.port} (realm: ${authInfo.realm})`);
      this.consoleErrors.push({
        level: 'warn',
        message: `HTTP 401 Auth required: ${authInfo.host} (realm: "${authInfo.realm}") — use browser_eval to set credentials or import auth cookies`,
        time: Date.now(),
      });
      callback(); // cancel the auth dialog — agent will handle via tools
    });

    // ── Renderer Hang Detection (Electron Native) ──
    // If the renderer process becomes unresponsive (infinite loop, massive GC pause),
    // the agent would keep trying to interact with a frozen page and waste steps.
    // These events give instant awareness: agent can wait or force-reload.
    this.view.webContents.on('unresponsive', () => {
      console.error('[BrowserViewManager] Page renderer is UNRESPONSIVE (possible hang)');
      this.consoleErrors.push({
        level: 'error',
        message: 'Page is UNRESPONSIVE — renderer may be hung. Consider waiting or reloading.',
        time: Date.now(),
      });
    });
    this.view.webContents.on('responsive', () => {
      console.log('[BrowserViewManager] Page renderer recovered — responsive again');
      this.consoleErrors.push({
        level: 'warn',
        message: 'Page recovered from unresponsive state — now interactive again.',
        time: Date.now(),
      });
    });

    // ── CORS / CSP Bypass (Electron Native) ──
    // Web pages embed restrictive headers that block cross-origin API calls
    // and inline script execution. The agent needs unrestricted access to
    // ALL data on the page, including XHR responses from different origins.
    // Strip these headers at the engine level — impossible for browser extensions.
    browserSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = details.responseHeaders || {};
      // Remove CORS restrictions
      delete headers['access-control-allow-origin'];
      delete headers['Access-Control-Allow-Origin'];
      headers['Access-Control-Allow-Origin'] = ['*'];
      // Remove X-Frame-Options to allow embedding any iframe
      delete headers['x-frame-options'];
      delete headers['X-Frame-Options'];
      // Relax CSP — some sites block inline scripts that the agent needs for eval
      delete headers['content-security-policy'];
      delete headers['Content-Security-Policy'];
      callback({ responseHeaders: headers });
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
    // Reset ALL state before reinit — old debugger/refs/labels/errors are invalid after view destroy
    this.cdpAttached = false;
    this.refMap.clear();
    this.refLabels.clear();
    this.currentTitle = '';
    this.consoleErrors = [];
    this.lastNetworkActivity = 0;
    this.targetFrame = null;
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
          const actualUrl = this.view!.webContents.getURL();
          const title = this.view!.webContents.getTitle();
          this.currentUrl = actualUrl;
          this.notifyRenderer('browser-view-navigated', { url: actualUrl, title });
          // Distinguish redirect (landed on new page) from genuine abort (stuck on old page)
          if (actualUrl && actualUrl !== 'about:blank' && actualUrl !== url) {
            return `Navigated to ${actualUrl} (redirected from ${url}). Title: ${title}`;
          }
          return `Navigation to ${url} was aborted. Still on: ${actualUrl}. Title: ${title}`;
        } catch {
          return `Navigation to ${url} was aborted.`;
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

      // goBack() is async — wait for did-navigate to fire rather than sleeping
      // a fixed 1500ms (which might read the old URL if the nav is slow).
      const navDone = new Promise<void>((resolve) => {
        const cleanup = () => {
          this.view?.webContents.removeListener('did-navigate', cleanup);
          this.view?.webContents.removeListener('did-navigate-in-page', cleanup);
          resolve();
        };
        this.view!.webContents.once('did-navigate', cleanup);
        this.view!.webContents.once('did-navigate-in-page', cleanup);
      });

      nav.goBack();
      // Wait for navigation with a 5s timeout fallback
      await Promise.race([navDone, new Promise<void>(r => setTimeout(r, 5000))]);

      const url = this.view!.webContents.getURL();
      this.currentUrl = url;
      this.notifyRenderer('browser-view-navigated', { url, title: this.view!.webContents.getTitle() });
      return `Went back. Now at: ${url}`;
    } catch (e: any) {
      return `GoBack error: ${e.message}`;
    }
  }

  // ── Page idle detection (Electron Native) ──

  /**
   * Wait until the page is truly idle.
   *
   * FOUR-LAYER detection driven from the main process (not injected JS):
   *
   *   Layer 0: PAGE LOADING STATE (Electron Native — synchronous)
   *     webContents.isLoading() tells us if Chromium's internal loading
   *     state machine is still active. Zero cost, no JS.
   *
   *   Layer 1: NETWORK QUIESCENCE (Electron Native — zero JS)
   *     session.webRequest listeners track all HTTP activity. If any request
   *     was sent/received in the last 800ms, the page is NOT idle.
   *
   *   Layer 2: DOM STABILITY (minimal JS — 1 line)
   *     Hash of document.body.innerText. If it changed, page is still loading.
   *
   *   Layer 3: LOADING INDICATORS (minimal JS — inline check)
   *     Definite (.thinking, .generating) = MUST wait.
   *     Ambiguous (.spinner, .loading) = apply 3s permanence heuristic.
   *
   * Returns a status string. Never throws.
   */
  async waitForIdle(maxWaitMs = 15_000): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';

    const POLL = 500;
    const STABLE_NEEDED = 2;
    const NETWORK_QUIET_MS = 800;
    const SPINNER_PERMANENT_MS = 3000;

    const start = Date.now();
    let stableCount = 0;
    let lastText = '';
    let spinnerStableMs = 0;

    // Minimal JS snippets — each is a single expression, no complex scripts
    const TEXT_EXTRACT_JS = `(document.body?.innerText||'').slice(0,500)`;
    const SPINNER_JS = `(()=>{
      const v=e=>{if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
      for(const s of['.thinking','.generating','[data-state="streaming"]','.response-loading']){const e=document.querySelector(s);if(e&&v(e))return 'D:'+s;}
      for(const s of['[aria-busy="true"]','.loading','.spinner','.skeleton','mat-progress-spinner','[role="progressbar"]','[data-loading="true"]']){const e=document.querySelector(s);if(e&&v(e))return 'A:'+s;}
      return '';
    })()`;

    while (Date.now() - start < maxWaitMs) {
      await new Promise(r => setTimeout(r, POLL));

      // Layer 0: Page loading state — Electron Native, synchronous, zero cost.
      // Chromium's internal loading state machine (covers document load, subresources).
      if (this.view?.webContents && !this.view.webContents.isDestroyed() && this.view.webContents.isLoading()) {
        stableCount = 0;
        spinnerStableMs = 0;
        continue;
      }

      // Layer 1: Network quiescence — Electron Native, zero JS injection.
      // If any HTTP request was sent/received recently, don't even bother checking DOM.
      const networkAge = Date.now() - this.lastNetworkActivity;
      if (this.lastNetworkActivity > 0 && networkAge < NETWORK_QUIET_MS) {
        stableCount = 0;
        spinnerStableMs = 0;
        continue;
      }

      // Layer 2: DOM text stability — minimal JS (extract first 500 chars to avoid hash collisions)
      let textNow = '';
      try {
        const frame = this.getExecutionFrame();
        if (frame) textNow = await frame.executeJavaScript(TEXT_EXTRACT_JS);
      } catch { textNow = 'error'; }

      const textChanged = textNow !== lastText || lastText === '';
      lastText = textNow;

      if (textChanged) {
        stableCount = 0;
        spinnerStableMs = 0;
      } else {
        stableCount++;
      }

      if (stableCount >= STABLE_NEEDED) {
        // Layer 3: Loading indicators — compact inline JS
        let spinnerResult = '';
        try {
          const frame = this.getExecutionFrame();
          if (frame) spinnerResult = await frame.executeJavaScript(SPINNER_JS);
        } catch {}

        if (spinnerResult.startsWith('D:')) {
          // Definite indicator (AI generating) — MUST keep waiting
          stableCount = STABLE_NEEDED - 1;
          continue;
        }

        if (!spinnerResult) {
          // No indicators — truly idle
          const elapsed = Date.now() - start;
          return `idle: network quiet ${networkAge}ms, DOM stable ${STABLE_NEEDED * POLL}ms after ${elapsed}ms`;
        }

        // Ambiguous indicator — apply permanence heuristic
        const indicator = spinnerResult.slice(2);
        spinnerStableMs += POLL;
        if (spinnerStableMs >= SPINNER_PERMANENT_MS) {
          const elapsed = Date.now() - start;
          return `idle: network quiet, DOM stable after ${elapsed}ms (${indicator} appears permanent)`;
        }
        stableCount = STABLE_NEEDED - 1; // re-evaluate next tick
      }
    }

    // Timeout — report why
    const networkAge = Date.now() - this.lastNetworkActivity;
    if (this.lastNetworkActivity > 0 && networkAge < NETWORK_QUIET_MS) {
      return `timeout: network still active after ${maxWaitMs}ms`;
    }
    return `timeout: DOM not stable after ${maxWaitMs}ms`;
  }

  // ── Script execution ──

  /** Get the frame to run scripts on (respects targetFrame if set). */
  private getExecutionFrame(): WebFrameMain | null {
    if (!this.view || !this.view.webContents || this.view.webContents.isDestroyed()) return null;
    if (this.targetFrame) {
      // Validate the frame is still alive
      try {
        this.targetFrame.url; // throws if frame is destroyed
        return this.targetFrame;
      } catch {
        console.warn('[BrowserViewManager] Target frame destroyed, falling back to mainFrame');
        this.targetFrame = null;
      }
    }
    return this.view.webContents.mainFrame;
  }

  async executeJS(script: string, timeoutMs = 600_000): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    const frame = this.getExecutionFrame();
    if (!frame) return 'Error: no execution frame available';
    try {
      // Auto-wrap scripts that use bare `return` (not inside a function/IIFE).
      // Without wrapping, a bare `return` at the top level causes SyntaxError.
      //
      // Fix: only skip wrapping for scripts that are already a complete expression
      // or IIFE (start with `(` or `{`). Previously, scripts starting with `const/let/var`
      // were incorrectly considered "self-enclosed" and not wrapped, causing
      // `const x = ...; return x;` to throw SyntaxError with e.message=undefined.
      const trimmed = script.trimStart();
      const isAlreadyIIFE = trimmed.startsWith('(') || trimmed.startsWith('{');
      const needsWrap = !isAlreadyIIFE && /\breturn\b/.test(script);
      const finalScript = needsWrap
        ? `(async () => { ${script} })()`
        : script;
      
      let timer: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      });

      const result = await Promise.race([
        frame.executeJavaScript(finalScript),
        timeoutPromise
      ]).finally(() => clearTimeout(timer));
      
      const val = result;
      if (val === null || val === undefined) {
        try {
          const fallback = await frame.executeJavaScript(
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

  // ── iframe traversal ──

  /**
   * List all frames (main + subframes) with their URLs.
   * Returns an array of { index, url, isMain } objects.
   * Subframe indices can be passed to switchToFrame().
   */
  getAllFrameInfos(): { index: number; url: string; isMain: boolean }[] {
    if (!this.ensureHealthyView()) return [];
    const results: { index: number; url: string; isMain: boolean }[] = [];
    let idx = 0;

    function walkFrames(frame: WebFrameMain, isMain: boolean) {
      try {
        results.push({ index: idx++, url: frame.url, isMain });
        for (const child of frame.frames) {
          walkFrames(child, false);
        }
      } catch {
        // Frame may have been destroyed
      }
    }

    walkFrames(this.view!.webContents.mainFrame, true);
    return results;
  }

  /**
   * Execute a script in ALL frames and collect results.
   * Returns results from every frame that successfully executes the script.
   */
  async executeJSAllFrames(script: string, timeoutMs = 15_000): Promise<{ frameIndex: number; frameUrl: string; result: string }[]> {
    if (!this.ensureHealthyView()) return [];
    const results: { frameIndex: number; frameUrl: string; result: string }[] = [];
    let idx = 0;

    const walkFrames = async (frame: WebFrameMain) => {
      const currentIdx = idx++;
      try {
        const result = await Promise.race([
          frame.executeJavaScript(script),
          new Promise<any>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), timeoutMs),
          ),
        ]);
        const str = result === null || result === undefined ? '' : (typeof result === 'string' ? result : JSON.stringify(result));
        if (str) {
          results.push({ frameIndex: currentIdx, frameUrl: frame.url, result: str });
        }
      } catch {
        // Frame execution failed (destroyed, CSP, etc.)
      }
      for (const child of frame.frames) {
        await walkFrames(child);
      }
    };

    await walkFrames(this.view!.webContents.mainFrame);
    return results;
  }

  /**
   * Switch the execution target to a specific subframe by index.
   * Use getAllFrameInfos() to list available frames and their indices.
   * Pass index=-1 or call resetTargetFrame() to return to the main frame.
   */
  switchToFrame(frameIndex: number): string {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    if (frameIndex < 0) {
      this.targetFrame = null;
      return 'Switched back to main frame.';
    }

    let idx = 0;
    let found: WebFrameMain | null = null;

    function walkFrames(frame: WebFrameMain) {
      if (found) return;
      if (idx === frameIndex) { found = frame; return; }
      idx++;
      for (const child of frame.frames) {
        walkFrames(child);
        if (found) return;
      }
    }

    walkFrames(this.view!.webContents.mainFrame);
    if (!found) return `Error: frame index ${frameIndex} not found. Use browser_list_frames to see available frames.`;
    
    this.targetFrame = found;
    return `Switched to frame ${frameIndex}: ${(found as WebFrameMain).url}`;
  }

  /** Reset target frame back to main frame. Also clears the CDP refMap since refs are per-snapshot. */
  resetTargetFrame(): void {
    this.targetFrame = null;
    // Bug fix #3: Clear refMap on navigation — old backendDOMNodeIds are invalid after page change
    this.refMap.clear();
  }

  // ── CDP / Native mouse click (engine-level, like a real user) ──

  /**
   * Click at absolute viewport coordinates using Chromium's native input pipeline.
   * This simulates a real mouse: mouseMove → mouseDown → (delay) → mouseUp.
   * Unlike el.click(), this triggers the FULL event chain (mousedown, mouseup, click,
   * pointerdown, pointerup) that modern frameworks (React, Vue, 126 NUI) rely on.
   */
  async nativeMouseClick(x: number, y: number): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    // Sanity check: if bounds are zero, view is not shown — click would be meaningless
    if (this.bounds.width < 10 || this.bounds.height < 10) {
      return 'Error: view bounds too small — is the browser panel visible?';
    }
    try {
      // Clamp to view bounds — clicking outside the WebContentsView is a no-op or error
      const cx = Math.max(1, Math.min(Math.round(x), this.bounds.width - 1));
      const cy = Math.max(1, Math.min(Math.round(y), this.bounds.height - 1));
      const wc = this.view!.webContents;
      wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy } as any);
      wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 } as any);
      await new Promise(r => setTimeout(r, 60));
      wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 } as any);
      return `Native click at (${cx}, ${cy})`;
    } catch (e: any) {
      return `Native click error: ${e.message}`;
    }
  }

  /**
   * Scroll the page using engine-level mouse wheel input events.
   * Frame-agnostic: scrolls whichever frame is under the center of the view,
   * without needing JS execution context or knowing which frame has focus.
   */
  sendMouseWheel(deltaY: number): void {
    if (!this.ensureHealthyView()) return;
    const cx = Math.round(this.bounds.width / 2);
    const cy = Math.round(this.bounds.height / 2);
    this.view!.webContents.sendInputEvent({
      type: 'mouseWheel',
      x: cx, y: cy,
      deltaX: 0, deltaY,
    } as any);
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

  /**
   * Capture a screenshot of the current WebContentsView as a JPEG data URL.
   * Returns null if the view is not available. Uses JPEG at 60% quality
   * to keep the data small (~50-100KB) for inline display in the timeline UI.
   */
  async captureScreenshot(): Promise<string | null> {
    if (!this.ensureHealthyView()) return null;
    try {
      const image = await this.view!.webContents.capturePage();
      if (image.isEmpty()) return null;
      const jpeg = image.toJPEG(60);
      return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    } catch (e: any) {
      console.warn('[BrowserViewManager] captureScreenshot failed:', e.message);
      return null;
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

  // ── Electron Native public API ──

  /**
   * Get recent console errors/warnings from the page (Electron Native).
   * Returns the last 10 entries. Agent can use this to understand why
   * a page isn't working without looking at DOM or DevTools.
   */
  getRecentErrors(): { level: string; message: string; time: number }[] {
    return [...this.consoleErrors];
  }

  /** Clear the console error buffer (e.g. after agent has processed them). */
  clearConsoleErrors(): void {
    this.consoleErrors = [];
  }

  /**
   * Check if the page is currently loading (Electron Native, synchronous).
   * Uses Chromium's internal loading state machine — covers document load,
   * subresource loading, and iframe loading. Zero JS injection needed.
   */
  isPageLoading(): boolean {
    return this.view?.webContents?.isLoading() ?? false;
  }

  // ── Cookie / Session Management (Electron Native) ──

  /**
   * Export all cookies for the browser session.
   * Use this to persist login state across app restarts.
   * No browser extension can do this — they only get cookies for their own domain.
   */
  async exportCookies(): Promise<Electron.Cookie[]> {
    const browserSession = session.fromPartition('persist:browser-panel');
    return browserSession.cookies.get({});
  }

  /**
   * Export cookies for a specific URL (e.g. just Google or just 126.com).
   */
  async getCookiesForUrl(url: string): Promise<Electron.Cookie[]> {
    const browserSession = session.fromPartition('persist:browser-panel');
    return browserSession.cookies.get({ url });
  }

  /**
   * Import cookies — restore a previously saved session.
   * Agent can log in once, export cookies, and restore them next time.
   */
  async importCookies(cookies: Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number }>): Promise<string> {
    const browserSession = session.fromPartition('persist:browser-panel');
    let imported = 0;
    for (const c of cookies) {
      try {
        const protocol = c.secure ? 'https' : 'http';
        const domain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
        await browserSession.cookies.set({
          url: `${protocol}://${domain}${c.path || '/'}`,
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path || '/',
          secure: c.secure,
          httpOnly: c.httpOnly,
          expirationDate: c.expirationDate,
        });
        imported++;
      } catch (e: any) {
        console.warn(`[BrowserViewManager] Failed to import cookie ${c.name}:`, e.message);
      }
    }
    return `Imported ${imported}/${cookies.length} cookies`;
  }

  /**
   * Clear all cookies and storage for the browser session.
   */
  async clearSession(): Promise<string> {
    const browserSession = session.fromPartition('persist:browser-panel');
    await browserSession.clearStorageData();
    return 'Session cleared (cookies, localStorage, cache)';
  }

  // ── Native Page Search (Electron Native) ──

  /**
   * Search for text on the page using Chromium's built-in find-in-page.
   * This works across shadow DOM, iframes, and even canvas-rendered text —
   * places where JS `document.querySelector` and `innerText` can't reach.
   * Returns match count. The first match is automatically scrolled into view.
   */
  async findInPage(text: string): Promise<{ matches: number; activeMatch: number }> {
    if (!this.ensureHealthyView()) return { matches: 0, activeMatch: 0 };
    return new Promise((resolve) => {
      const wc = this.view!.webContents;
      // found-in-page fires for each match found; finalUpdate=true means search is complete
      const handler = (_event: any, result: any) => {
        if (result.finalUpdate) {
          clearTimeout(timeout);
          wc.removeListener('found-in-page', handler);
          resolve({ matches: result.matches || 0, activeMatch: result.activeMatchOrdinal || 0 });
        }
      };
      const timeout = setTimeout(() => {
        wc.removeListener('found-in-page', handler); // prevent listener leak on timeout
        resolve({ matches: 0, activeMatch: 0 });
      }, 3000);
      wc.on('found-in-page', handler);
      wc.findInPage(text);
    });
  }

  /** Stop find-in-page and clear highlights. */
  stopFind(): void {
    this.view?.webContents.stopFindInPage('clearSelection');
  }

  // ── Zoom Control (Electron Native) ──

  /** Set page zoom factor (1.0 = 100%, 1.5 = 150%, etc.) */
  setZoom(factor: number): void {
    this.view?.webContents.setZoomFactor(Math.max(0.25, Math.min(5, factor)));
  }

  /** Get current zoom factor. */
  getZoom(): number {
    return this.view?.webContents.getZoomFactor() ?? 1;
  }

  // ── PDF Export (Electron Native) ──

  /**
   * Export the current page as a PDF file.
   * Uses Chromium's built-in print pipeline — bypasses all OS print dialogs.
   * No browser extension can do this without triggering the print dialog.
   *
   * @param outputPath Absolute path to save the PDF. Auto-generated if omitted.
   */
  async exportPDF(outputPath?: string): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    const fsP = require('node:fs/promises');
    const path = require('node:path');
    const os = require('node:os');
    const fp = outputPath || path.join(os.homedir(), 'Downloads', `page_${Date.now()}.pdf`);
    try {
      const data = await this.view!.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        preferCSSPageSize: true,
      });
      await fsP.mkdir(path.dirname(fp), { recursive: true });
      await fsP.writeFile(fp, data);
      return `PDF saved to ${fp} (${Math.round(data.length / 1024)}KB)`;
    } catch (e: any) {
      return `PDF export error: ${e.message}`;
    }
  }

  // ── Clipboard (Electron Native) ──

  /**
   * Read the current clipboard text content.
   * Browser extensions cannot do this without an explicit user gesture.
   * Useful when a page copies data to clipboard that the agent needs to capture.
   */
  readClipboard(): string {
    try {
      return clipboard.readText() || '(clipboard is empty)';
    } catch (e: any) {
      return `Clipboard read error: ${e.message}`;
    }
  }

  /**
   * Write text to the system clipboard.
   * Useful to pass extracted data from the page to other applications.
   */
  writeClipboard(text: string): string {
    try {
      clipboard.writeText(text);
      return `Wrote ${text.length} chars to clipboard`;
    } catch (e: any) {
      return `Clipboard write error: ${e.message}`;
    }
  }

  // ── Page Health (Electron Native) ──

  /**
   * Get a comprehensive page health summary — single call, zero JS injection.
   * All data comes from Electron Native APIs, not from the DOM.
   * Agent can use this for instant situational awareness without a full snapshot.
   */
  getPageHealth(): {
    url: string;
    title: string;
    loading: boolean;
    networkActiveMs: number;
    recentErrors: number;
    zoom: number;
    canGoBack: boolean;
    canGoForward: boolean;
  } {
    const wc = this.view?.webContents;
    const networkActiveMs = this.lastNetworkActivity > 0
      ? Math.max(0, Date.now() - this.lastNetworkActivity)
      : -1;
    const nav = wc?.navigationHistory;
    return {
      url: wc?.getURL() || this.currentUrl || '',
      title: this.currentTitle || wc?.getTitle() || '',
      loading: wc?.isLoading() ?? false,
      networkActiveMs,  // ms since last network activity (-1 = no activity yet)
      recentErrors: this.consoleErrors.filter(e => Date.now() - e.time < 30_000).length,
      zoom: wc?.getZoomFactor() ?? 1,
      canGoBack: nav?.canGoBack() ?? false,
      canGoForward: nav?.canGoForward() ?? false,
    };
  }

  // ── File Upload (CDP — zero OS dialog) ──

  /**
   * Set file(s) on a file input element — bypasses the native file picker dialog.
   *
   * The agent encounters <input type="file"> on every site with upload forms
   * (email attachments, avatar upload, document submission). Without this,
   * clicking the file input triggers a native OS dialog that blocks forever.
   *
   * Uses CDP DOM.setFileInputFiles which programmatically assigns files to the
   * input element, firing all the right DOM events (change, input) that the
   * page's JavaScript expects.
   *
   * @param ref Element ref from snapshot (must be an input[type=file])
   * @param filePaths Array of absolute file paths to upload
   */
  async setFileForUpload(ref: string, filePaths: string[]): Promise<string> {
    const backendNodeId = this.refMap.get(ref);
    if (!backendNodeId) return `Error: ref ${ref} not found. Run browser_snapshot first.`;
    if (!await this.ensureCDP()) return 'Error: CDP not available';

    try {
      await this.cdpCommand('DOM.setFileInputFiles', {
        files: filePaths,
        backendNodeId,
      });
      return `Set ${filePaths.length} file(s) on [${ref}]: ${filePaths.map(f => f.split('/').pop()).join(', ')}`;
    } catch (e: any) {
      return `File upload error: ${e.message}`;
    }
  }

  // ── Network Response Capture (CDP — direct API access) ──

  /**
   * Capture the next network response matching a URL pattern.
   *
   * When the agent visits API-driven SPAs (React dashboards, search results),
   * the useful data is in XHR/fetch JSON responses, not in the rendered HTML.
   * This enables the agent to read raw API responses directly.
   *
   * Uses CDP Network domain: enable monitoring → wait for matching request →
   * extract response body. A capability that would require a browser extension
   * with full devtools API in Chrome.
   *
   * @param urlPattern Substring match against request URLs (e.g. "/api/search")
   * @param timeoutMs How long to wait for a matching request (default: 15s)
   */
  async captureNetworkResponse(urlPattern: string, timeoutMs = 15000): Promise<string> {
    if (!await this.ensureCDP()) return 'Error: CDP not available';

    try {
      await this.cdpCommand('Network.enable');

      return new Promise<string>((resolve) => {
        const debugger_ = this.view!.webContents.debugger;
        let settled = false;
        let targetRequestId = '';
        let targetUrl = '';

        const cleanup = () => {
          debugger_.removeListener('message', handler);
          clearTimeout(timer);
        };

        const handler = async (_event: any, method: string, params: any) => {
          if (settled) return;

          if (method === 'Network.responseReceived') {
            const url: string = params.response?.url || '';
            if (url.includes(urlPattern) && !targetRequestId) {
              targetRequestId = params.requestId;
              targetUrl = url;
            }
          } else if (method === 'Network.loadingFinished' && targetRequestId === params.requestId) {
            settled = true;
            cleanup();
            try {
              const { body, base64Encoded } = await this.cdpCommand(
                'Network.getResponseBody',
                { requestId: targetRequestId }
              );
              const content = base64Encoded
                ? Buffer.from(body, 'base64').toString('utf-8')
                : body;
              const preview = content.length > 50000
                ? content.slice(0, 50000) + '\n...(truncated)'
                : content;
              resolve(`Captured response from ${targetUrl} (${content.length} chars):\n${preview}`);
            } catch (e: any) {
              resolve(`Matched ${targetUrl} but failed to read body: ${e.message}`);
            }
          }
        };

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            cleanup();
            resolve(`No network response matching "${urlPattern}" within ${timeoutMs}ms. Try navigating or clicking to trigger the request.`);
          }
        }, timeoutMs);

        debugger_.on('message', handler);
      });
    } catch (e: any) {
      return `Network capture error: ${e.message}`;
    }
  }

  /**
   * Attach the CDP debugger to the WebContentsView.
   * Uses Electron's built-in `webContents.debugger` API which provides
   * full Chrome DevTools Protocol access without a separate socket.
   * Auto-reattaches if previously detached.
   */
  async ensureCDP(): Promise<boolean> {
    if (!this.view || this.view.webContents.isDestroyed()) return false;
    if (this.cdpAttached) return true;
    try {
      this.view.webContents.debugger.attach('1.3');
      this.cdpAttached = true;
      // Bug fix #2: Use removeAllListeners+once to prevent accumulating detach listeners
      // across multiple attach/detach cycles (e.g. page navigations).
      this.view.webContents.debugger.removeAllListeners('detach');
      this.view.webContents.debugger.once('detach', () => {
        this.cdpAttached = false;
        this.refMap.clear();    // Refs are invalid after detach
        this.refLabels.clear(); // Labels are stale too
      });
      return true;
    } catch (e: any) {
      if (e.message?.includes('Already attached')) {
        this.cdpAttached = true;
        return true;
      }
      console.warn('[BrowserViewManager] CDP attach failed:', e.message);
      return false;
    }
  }

  /** Send a CDP command. Auto-retries once if the target detached asynchronously (process swap). */
  async cdpCommand(method: string, params?: Record<string, any>, retries = 1): Promise<any> {
    if (!this.view || this.view.webContents.isDestroyed()) {
      throw new Error('CDP not attached: view destroyed');
    }
    
    // Ensure we are attached before attempting
    await this.ensureCDP();

    try {
      return await this.view.webContents.debugger.sendCommand(method, params);
    } catch (e: any) {
      if (retries > 0 && e.message?.includes('not attached')) {
        // Race condition: target detached asynchronously after ensureCDP (e.g. process swap).
        // Force state reset, wait a bit for Electron to settle, and retry.
        this.cdpAttached = false;
        try { this.view.webContents.debugger.detach(); } catch {}
        await new Promise(r => setTimeout(r, 100));
        return this.cdpCommand(method, params, retries - 1);
      }
      throw e;
    }
  }

  /** Detach CDP debugger (cleanup). */
  detachCDP(): void {
    if (this.cdpAttached && this.view && !this.view.webContents.isDestroyed()) {
      try { this.view.webContents.debugger.detach(); } catch {}
    }
    this.cdpAttached = false;
  }

  /**
   * Get a text snapshot of the page using CDP's Accessibility Tree.
   *
   * KEY ARCHITECTURAL ADVANTAGE — Electron Privileged CDP:
   *   Unlike external CDP clients (Playwright, Puppeteer), our debugger runs
   *   inside Electron's main process. This gives us PRIVILEGED access to
   *   cross-origin iframes. We use Page.getFrameTree() to discover ALL frames
   *   (including cross-origin ones like passport.126.com inside mail.126.com),
   *   then call Accessibility.getFullAXTree({ frameId }) for EACH frame.
   *   External clients cannot do this — they're blocked by same-origin policy.
   *
   * Each interactive element gets a short ref (e1, e2, ...) mapped to its
   * backendDOMNodeId for later interaction via getElementCenterByCDP/focusElementByCDP.
   */
  async getAccessibilitySnapshot(): Promise<string> {
    if (!await this.ensureCDP()) throw new Error('CDP not available');

    // Step 1: Discover ALL frames via Page.getFrameTree (includes cross-origin)
    const allFrameIds: { id: string; url: string }[] = [];
    try {
      // Ensure DOM is enabled so backendDOMNodeId is populated in the AX tree
      await this.cdpCommand('DOM.enable').catch(() => {});
      
      const { frameTree } = await this.cdpCommand('Page.getFrameTree');
      const collectFrames = (tree: any) => {
        allFrameIds.push({ id: tree.frame.id, url: tree.frame.url || '' });
        if (tree.childFrames) {
          for (const child of tree.childFrames) collectFrames(child);
        }
      };
      collectFrames(frameTree);
    } catch (e: any) {
      console.warn('[BrowserViewManager] Page.getFrameTree failed, falling back to main frame only:', e.message);
      allFrameIds.push({ id: '', url: this.getUrl() }); // empty id = no frameId param = main frame
    }

    // Step 2: Collect AX nodes from ALL frames CONCURRENTLY
    let allNodes: any[] = [];
    const frameUrlMap = new Map<string, string>(); // frameId → URL for annotation

    const framePromises = allFrameIds.map(async (frame) => {
      try {
        const params: any = { depth: -1 };
        if (frame.id) params.frameId = frame.id;

        let timer: NodeJS.Timeout;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('AXTree timeout')), 5000);
        });

        const { nodes } = await Promise.race([
          this.cdpCommand('Accessibility.getFullAXTree', params),
          timeoutPromise
        ]).finally(() => clearTimeout(timer));
        // Tag each node with its frame URL for output annotation
        for (const node of nodes) {
          node._frameUrl = frame.url;
          node._frameId = frame.id;
        }
        return { frame, nodes };
      } catch (e: any) {
        console.warn(`[BrowserViewManager] AXTree failed for frame ${frame.id || 'main'}:`, e.message);
        // Frame might have been destroyed or is truly empty — skip silently
        return { frame, nodes: [] };
      }
    });

    const frameResults = await Promise.all(framePromises);
    for (const { frame, nodes } of frameResults) {
      if (nodes.length > 0) {
        allNodes = allNodes.concat(nodes);
        frameUrlMap.set(frame.id, frame.url);
      }
    }

    // Step 3: Format into compact text with refs
    const lines: string[] = [];
    let refCounter = 0;
    const newRefMap = new Map<string, number>();
    const newRefLabels = new Map<string, string>();
    const frameIds = new Set<string>();
    let currentFrameUrl = '';

    lines.push(`Page: ${this.getTitle()}`);
    lines.push(`URL: ${this.getUrl()}`);
    lines.push('');

    const INTERACTIVE_ROLES = BrowserViewManager.INTERACTIVE_ROLES; // use static constant

    // Diagnostic counters for understanding CDP quality
    let totalNodes = 0;
    let ignoredNodes = 0;
    let interactiveWithBackendId = 0;
    let interactiveWithoutBackendId = 0;
    const roleCounts = new Map<string, number>();

    for (const node of allNodes) {
      totalNodes++;
      if (node.ignored) { ignoredNodes++; continue; }

      const role: string = node.role?.value || '';
      const name: string = (node.name?.value || '').trim();
      const value: string = (node.value?.value || '').trim();
      const backendId: number | undefined = node.backendDOMNodeId;
      const nodeFrameUrl: string = node._frameUrl || '';
      if (node._frameId) frameIds.add(node._frameId);

      // Track role distribution for diagnostics
      if (role) roleCounts.set(role, (roleCounts.get(role) || 0) + 1);

      // Annotate when we enter a new frame's content (helps agent understand page structure)
      if (nodeFrameUrl && nodeFrameUrl !== currentFrameUrl && nodeFrameUrl !== 'about:blank') {
        currentFrameUrl = nodeFrameUrl;
        if (frameIds.size > 1) {
          // Only annotate non-main frames
          const host = (() => { try { return new URL(nodeFrameUrl).hostname; } catch { return nodeFrameUrl.slice(0, 50); } })();
          lines.push(`\n--- frame: ${host} ---`);
        }
      }

      const props: any[] = node.properties || [];
      const isDisabled = props.some((p: any) => p.name === 'disabled' && p.value?.value === true);
      const isEditable = props.some((p: any) => p.name === 'editable' && p.value?.value);

      // Interactive elements get refs
      if (INTERACTIVE_ROLES.has(role) || isEditable) {
        if (backendId) {
          interactiveWithBackendId++;
          refCounter++;
          const ref = `e${refCounter}`;
          newRefMap.set(ref, backendId);
          // Cache the label so getElementCenterByCDP doesn't need a DOM.describeNode round-trip
          const displayName = name || role;
          newRefLabels.set(ref, displayName);

          const disabledTag = isDisabled ? ' [DISABLED]' : '';
          const valueDisplay = value ? ` value="${value.slice(0, 40)}"` : '';
          lines.push(`[${ref}] ${role} "${displayName.slice(0, 60)}"${valueDisplay}${disabledTag}`);
        } else {
          interactiveWithoutBackendId++;
        }
      }
      // Headings
      else if (role === 'heading' && name) {
        lines.push(`heading: ${name.slice(0, 80)}`);
      }
      // Static text (only substantial blocks)
      else if (role === 'staticText' && name.length > 15 && name.length < 200) {
        lines.push(`text: ${name.slice(0, 120)}`);
      }
      // Images
      else if (role === 'image' && name && backendId) {
        refCounter++;
        const ref = `e${refCounter}`;
        newRefMap.set(ref, backendId);
        newRefLabels.set(ref, name);
        lines.push(`[${ref}] img "${name.slice(0, 60)}"`);
      }
    }

    // Log CDP AXTree diagnostics
    const topRoles = [...roleCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([r, c]) => `${r}:${c}`).join(', ');
    console.log(`[BrowserViewManager] CDP AXTree: ${totalNodes} nodes (${ignoredNodes} ignored), ${interactiveWithBackendId} interactive+backendId, ${interactiveWithoutBackendId} interactive-NO-backendId, refs=${refCounter}. Top roles: ${topRoles}`);

    this.refMap = newRefMap;
    this.refLabels = newRefLabels;

    if (frameIds.size > 1) {
      lines.push(`\n📌 Content spans ${frameIds.size} frames (cross-origin included — all refs work directly, no need to switch frames).`);
    }

    // Auto-include recent console errors — agent sees page problems immediately
    const recentErrors = this.consoleErrors.filter(e => Date.now() - e.time < 30_000); // last 30s
    if (recentErrors.length > 0) {
      lines.push(`\n⚠️ Recent page errors:`);
      for (const err of recentErrors.slice(-5)) {
        lines.push(`  [${err.level}] ${err.message}`);
      }
    }

    // Smart cap: preserve original line ORDER (critical for agent context — headings
    // introduce the buttons below them). But if there are very many interactive elements,
    // ensure they all fit within 500 lines total.
    // Strategy: if total fits, return all. Otherwise, keep first 400 lines (which covers
    // most pages) and ensure any interactive lines beyond that are appended.
    if (lines.length <= 500) return lines.join('\n');

    // Page has > 500 lines: keep first 400 in-order, then append any [eN] refs
    // that were cut off (so agent always has all interactive targets).
    const first400 = lines.slice(0, 400);
    const first400Set = new Set(first400);
    const missedRefs = lines.slice(400).filter(l => l.startsWith('[e') && !first400Set.has(l));
    if (missedRefs.length > 0) {
      first400.push(`\n… (${lines.length - 400} lines truncated, ${missedRefs.length} refs appended below)`);
      first400.push(...missedRefs);
    }
    return first400.join('\n');
  }

  /**
   * Get element center coordinates using CDP DOM.getContentQuads.
   * Returns viewport-absolute coordinates suitable for nativeMouseClick().
   * Works cross-frame — no need to compute iframe offsets manually.
   */
  async getElementCenterByCDP(ref: string): Promise<{ x: number; y: number; label: string } | null> {
    const backendNodeId = this.refMap.get(ref);
    if (!backendNodeId) {
      // Ref not found — could mean page state changed after last snapshot.
      // Caller should re-run browser_snapshot to refresh refs.
      return null;
    }

    try {
      if (!await this.ensureCDP()) return null;

      // Scroll into view first
      try {
        await this.cdpCommand('DOM.scrollIntoViewIfNeeded', { backendNodeId });
      } catch { /* element might already be visible */ }

      // Get content quads — returns viewport coordinates
      const { quads } = await this.cdpCommand('DOM.getContentQuads', { backendNodeId });
      if (!quads || quads.length === 0) return null;

      // First quad: [x1,y1, x2,y2, x3,y3, x4,y4]
      const q = quads[0];
      const cx = Math.round((q[0] + q[2] + q[4] + q[6]) / 4);
      const cy = Math.round((q[1] + q[3] + q[5] + q[7]) / 4);

      // Use cached label from AX snapshot — eliminates a DOM.describeNode round-trip
      const label = this.refLabels.get(ref) || ref;

      return { x: cx, y: cy, label };
    } catch (e: any) {
      console.warn(`[BrowserViewManager] CDP getContentQuads failed for ${ref}:`, e.message);
      return null;
    }
  }

  /**
   * Focus an element by ref using CDP DOM.focus.
   * Works cross-frame — CDP handles iframe context automatically.
   */
  async focusElementByCDP(ref: string): Promise<string> {
    const backendNodeId = this.refMap.get(ref);
    if (!backendNodeId) return `Error: ref ${ref} not found. Run browser_snapshot first.`;

    try {
      if (!await this.ensureCDP()) return 'Error: CDP not available';
      await this.cdpCommand('DOM.focus', { backendNodeId });
      return `Focused [${ref}] via CDP`;
    } catch (e: any) {
      return `CDP focus error: ${e.message}`;
    }
  }

  /** Check if CDP-based refs are available (i.e., a CDP snapshot was taken). */
  hasCDPRefs(): boolean {
    return this.refMap.size > 0;
  }

  /** Get the backendDOMNodeId for a ref. */
  getRefBackendNodeId(ref: string): number | undefined {
    return this.refMap.get(ref);
  }

  /**
   * Get the human-readable label for a ref (from the last AX snapshot).
   * Used by browser-use.ts to build action log messages without accessing private state.
   */
  getRefLabel(ref: string): string {
    return this.refLabels.get(ref) || ref;
  }

  // ── Visual Element Overlay ──
  //
  // Two-tier architecture for full transparency:
  //
  //   Tier 1 — CDP Overlay (single element, zero DOM injection)
  //     Used by highlightRef() for per-action flash.
  //     Chromium's own compositor paints an orange box ABOVE all content.
  //     Limitation: only one node at a time (Overlay.highlightNode overwrites).
  //
  //   Tier 2 — Shadow DOM Overlay (multi-element X-ray)
  //     Used by highlightAllRefs() to render ALL refs simultaneously.
  //     Injects a single <div> shadow host with pointer-events:none,
  //     containing absolutely-positioned colored boxes with [eN] labels.
  //     Shadow DOM isolates overlay CSS from page styles.
  //     Removed cleanly by clearOverlay().

  /**
   * Flash a highlight on a specific element ref before the agent interacts with it.
   * Orange box = "agent is about to act on this element".
   * Automatically clears after `durationMs` milliseconds.
   *
   * Uses CDP Overlay domain — zero DOM injection, rendered by Chromium's compositor.
   * Called automatically by browserClick and browserType for full transparency.
   */
  async highlightRef(ref: string, durationMs = 800): Promise<void> {
    const backendNodeId = this.refMap.get(ref);
    if (!backendNodeId) return;
    if (!await this.ensureCDP()) return;

    try {
      await this.cdpCommand('Overlay.enable');

      await this.cdpCommand('Overlay.highlightNode', {
        highlightConfig: {
          showInfo: true,
          showStyles: false,
          showRulers: false,
          showAccessibilityInfo: false,
          contentColor:  { r: 255, g: 140, b:  0, a: 0.25 }, // orange fill
          borderColor:   { r: 255, g: 140, b:  0, a: 0.9  }, // orange border
          marginColor:   { r: 255, g: 140, b:  0, a: 0.05 },
        },
        backendNodeId,
      });

      // Auto-clear after duration
      setTimeout(() => {
        this.cdpCommand('Overlay.hideHighlight').catch(() => {});
      }, durationMs);
    } catch {
      // Overlay may not be supported — non-fatal
    }
  }

  /**
   * Render ALL refs simultaneously as labeled, colored boxes — "X-ray vision".
   *
   * ARCHITECTURE NOTE: CDP Overlay.highlightNode only supports ONE node at a time
   * (each call overwrites the previous). To draw 50+ boxes simultaneously, we use
   * a Shadow DOM overlay: get each ref's viewport coordinates via DOM.getContentQuads,
   * then inject a single shadow host with absolutely-positioned <div> boxes.
   *
   * The shadow host has:
   *   - pointer-events: none (doesn't block user interaction)
   *   - z-index: 2147483647 (above everything)
   *   - position: fixed (stays in viewport during scroll)
   *   - CSS isolation via Shadow DOM (zero pollution to page styles)
   *
   * Result: a complete "agent's eye view" showing every interactive element
   * the agent can see and target, each with its [eN] label badge.
   */
  async highlightAllRefs(): Promise<string> {
    if (this.refMap.size === 0) return 'No refs — run browser_snapshot first.';
    if (!await this.ensureCDP()) return 'Error: CDP not available';

    try {
      // Step 1: Collect viewport coordinates for all refs via CDP CONCURRENTLY
      const quadPromises = Array.from(this.refMap.entries()).map(async ([ref, backendNodeId]) => {
        try {
          // Ensure node is resolved in CDP's DOM tree
          const { quads } = await Promise.race([
            this.cdpCommand('DOM.getContentQuads', { backendNodeId }),
            new Promise<any>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 2000))
          ]);
          if (!quads || quads.length === 0) return null;

          // First quad: [x1,y1, x2,y2, x3,y3, x4,y4] — compute bounding box
          const q = quads[0];
          const xs = [q[0], q[2], q[4], q[6]];
          const ys = [q[1], q[3], q[5], q[7]];
          const minX = Math.min(...xs);
          const minY = Math.min(...ys);
          const maxX = Math.max(...xs);
          const maxY = Math.max(...ys);
          const w = maxX - minX;
          const h = maxY - minY;

          // Skip zero-size elements (invisible/collapsed)
          if (w < 2 && h < 2) return null;

          const label = this.refLabels.get(ref) || ref;
          return { ref, label: label.slice(0, 20), x: Math.round(minX), y: Math.round(minY), w: Math.round(w), h: Math.round(h) };
        } catch {
          // Node may have been destroyed — skip silently
          return null;
        }
      });

      const results = await Promise.all(quadPromises);
      const boxes = results.filter(Boolean) as typeof results[0][];

      if (boxes.length === 0) return 'No visible elements to highlight.';

      // Step 2: Inject Shadow DOM overlay into the page
      // The entire overlay lives inside a Shadow DOM so it cannot be polluted
      // by page CSS, and the page cannot accidentally interact with it.
      const boxesJSON = JSON.stringify(boxes);
      await this.executeJS(`
        (function() {
          // Remove any previous overlay
          const old = document.getElementById('dsme-overlay-root');
          if (old) old.remove();

          // Create shadow host
          const host = document.createElement('div');
          host.id = 'dsme-overlay-root';
          host.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:none;';
          document.documentElement.appendChild(host);

          const shadow = host.attachShadow({ mode: 'open' });

          // Inject styles into shadow DOM
          const style = document.createElement('style');
          style.textContent = \`
            :host { all: initial; }
            .dsme-box {
              position: fixed;
              border: 2px solid rgba(59, 130, 246, 0.85);
              background: rgba(59, 130, 246, 0.08);
              border-radius: 3px;
              pointer-events: none;
              box-sizing: border-box;
              transition: opacity 0.2s;
            }
            .dsme-label {
              position: absolute;
              top: -1px;
              left: -1px;
              background: rgba(59, 130, 246, 0.9);
              color: #fff;
              font: bold 9px/1 -apple-system, sans-serif;
              padding: 1px 4px;
              border-radius: 0 0 3px 0;
              white-space: nowrap;
              pointer-events: none;
            }
          \`;
          shadow.appendChild(style);

          // Render boxes
          const boxes = ${boxesJSON};
          for (const b of boxes) {
            const div = document.createElement('div');
            div.className = 'dsme-box';
            div.style.left = b.x + 'px';
            div.style.top = b.y + 'px';
            div.style.width = Math.max(b.w, 4) + 'px';
            div.style.height = Math.max(b.h, 4) + 'px';

            const lbl = document.createElement('span');
            lbl.className = 'dsme-label';
            lbl.textContent = b.ref;
            div.appendChild(lbl);

            shadow.appendChild(div);
          }
        })()
      `);

      return `X-ray: ${boxes.length} of ${this.refMap.size} refs highlighted with [eN] labels. Run browser_clear_overlay() to dismiss.`;
    } catch (e: any) {
      return `Overlay error: ${e.message}`;
    }
  }

  /**
   * Clear all visual overlays.
   * Handles both:
   *   - CDP single-node overlay (from highlightRef)
   *   - Shadow DOM multi-node overlay (from highlightAllRefs)
   */
  async clearOverlay(): Promise<void> {
    // Clear CDP overlay
    if (this.cdpAttached) {
      try {
        await this.cdpCommand('Overlay.hideHighlight');
        await this.cdpCommand('Overlay.disable');
      } catch {}
    }

    // Clear Shadow DOM overlay
    try {
      await this.executeJS(`
        (function() {
          const el = document.getElementById('dsme-overlay-root');
          if (el) el.remove();
        })()
      `);
    } catch {}
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
