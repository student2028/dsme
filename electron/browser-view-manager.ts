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

import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  WebContentsView,
  BrowserWindow,
  session,
  WebFrameMain,
  clipboard,
  app,
  dialog,
  type Cookie,
  type Event,
  type OnBeforeRequestListenerDetails,
  type OnCompletedListenerDetails,
} from 'electron';
import { getErrorMessage } from './lib/errors';
import type { JsonObject } from './types/common';
import type { WebContentsInputEvent } from './types/input-events';
import {
  formatAxSnapshot,
  type AxNode,
  type FrameTreeNode,
} from './browser/ax-snapshot-format';

export class BrowserViewManager {
  private view: WebContentsView | null = null;
  private mainWindow: BrowserWindow | null = null;
  private visible = false;
  private attached = false;
  private currentUrl = '';
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private lastMouseX = -1;
  private lastMouseY = -1;
  /** When set, executeJS/insertText/pressKey operate on this subframe instead of mainFrame. */
  private targetFrame: WebFrameMain | null = null;
  /** Counter for Process Recycling to prevent memory leaks in long-running tasks. */
  private navigationCount = 0;

  // ── Electron Native state ──
  /** Timestamp of last network activity (request sent, response received, etc.) */
  private lastNetworkActivity = 0;
  /** Ring buffer of recent console errors/warnings from the page. */
  private readonly MAX_CONSOLE_ERRORS = 10;
  private consoleErrors: Array<{ level: string; message: string; time: number }> = [];

  /** Centralized ring-buffer push for consoleErrors. Prevents unbounded growth. */
  private pushConsoleError(level: string, message: string) {
    this.consoleErrors.push({ level, message: message.slice(0, 200), time: Date.now() });
    if (this.consoleErrors.length > this.MAX_CONSOLE_ERRORS) this.consoleErrors.shift();
  }
  /** Live page title tracked via page-title-updated event (Electron Native). */
  private currentTitle = '';

  // ── CDP (read-only query layer) state ──
  private cdpAttached = false;
  /** Coalescing lock: if ensureCDP is already in-flight, concurrent callers await this. */
  private cdpAttachingPromise: Promise<boolean> | null = null;
  /** Maps short refs (e1, e2, ...) to CDP backendDOMNodeId and frameId for interaction. */
  private refMap = new Map<string, { backendNodeId: number; frameId: string }>();
  /**
   * Maps short refs to human-readable labels from the AX snapshot.
   * Eliminates the extra DOM.describeNode round-trip in getElementCenterByCDP.
   */
  private refLabels = new Map<string, string>();
  
  // ── Network Sniffing (CDP MITM) ──
  private recentNetworkRequests = new Map<string, { url: string; method: string; mimeType: string; status: number; timestamp: number; sessionId?: string }>();
  private networkListenerAttached = false;
  /** Set of request IDs currently in flight. Set used to prevent redirect counting bugs. */
  private inflightRequests = new Set<number>();
  
  // ── OOPIF Session Routing ──
  /** Maps frameId/targetId to CDP sessionId for communicating with cross-origin iframes. */
  private oopifSessions = new Map<string, string>();

  // ── UI / Overlay ──
  private highlightTimeout: NodeJS.Timeout | null = null;

  // ── Download Tracking ──
  private recentDownloads: { filename: string; path: string; state: string; time: number; size?: number }[] = [];

  // ── Static constants (defined once, not rebuilt per call) ──
  private static readonly INTERACTIVE_ROLES = new Set([
    'textbox', 'button', 'link', 'combobox', 'listbox',
    'checkbox', 'radio', 'slider', 'searchbox', 'menuitem',
    'tab', 'switch', 'spinbutton', 'option', 'menuitemcheckbox',
    'menuitemradio', 'treeitem',
  ]);

  /** Exposed for browser-use step notifications. */
  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  /** @internal Frame routing for browser-use JS ref fallback */
  getTargetFrame(): WebFrameMain | null {
    return this.targetFrame;
  }

  setTargetFrameInternal(frame: WebFrameMain | null): void {
    this.targetFrame = frame;
  }

  /** Call once after the main BrowserWindow is created. */
  init(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;

    const browserSession = session.fromPartition('persist:browser-panel-v2');

    this.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        session: browserSession,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true, // MUST be true for Google Login cookies (SameSite policy) to work
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
      details.requestHeaders['Accept-Language'] = 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7';
      callback({ requestHeaders: details.requestHeaders });
    });

    // ── Network activity tracking (Electron Native — no CDP, no JS injection) ──
    // Pure observation listeners that track when any HTTP activity occurs.
    // Used by waitForIdle() to know when the network is truly quiet.
    // Filter out telemetry/analytics to prevent false "busy" signals from heartbeats.
    const TELEMETRY_DOMAINS = /\b(google-analytics\.com|analytics\.google\.com|googletagmanager\.com|clarity\.ms|hotjar\.com|hotjar\.io|segment\.io|segment\.com|mixpanel\.com|amplitude\.com|sentry\.io|doubleclick\.net|googlesyndication\.com|facebook\.net|fbevents|bat\.bing\.com)\b/i;
    const TELEMETRY_PATHS = /\/(beacon|collect|pixel|telemetry|heartbeat|__utm|pageview|v1\/track)\b/i;

    const isTelemetry = (url: string, type: string) => {
      if (type === 'ping' || type === 'csp_report' || type === 'beacon') return true;
      return TELEMETRY_DOMAINS.test(url) || TELEMETRY_PATHS.test(url);
    };

    const trackNetworkStart = (details: OnBeforeRequestListenerDetails) => {
      if (isTelemetry(details.url, details.resourceType)) return;
      this.inflightRequests.add(details.id);
      this.lastNetworkActivity = Date.now();
    };
    
    const trackNetworkEnd = (details: OnCompletedListenerDetails) => {
      // BUG FIX: Do NOT check isTelemetry here.
      // A request might start as non-telemetry (/api/data) and get 302-redirected
      // to a telemetry URL (google-analytics.com/collect). If we skip the delete
      // for telemetry URLs, the request ID stays in inflightRequests forever,
      // causing waitForIdle to think the network is permanently busy.
      // Deleting a non-existent ID from a Set is a safe no-op.
      this.inflightRequests.delete(details.id);
      if (!isTelemetry(details.url, details.resourceType)) {
        this.lastNetworkActivity = Date.now();
      }
    };

    browserSession.webRequest.onSendHeaders(trackNetworkStart);        // request sent
    browserSession.webRequest.onResponseStarted((details) => {
      if (!isTelemetry(details.url, details.resourceType)) this.lastNetworkActivity = Date.now();
    });    // first byte received
    browserSession.webRequest.onCompleted(trackNetworkEnd);          // request completed
    browserSession.webRequest.onErrorOccurred(trackNetworkEnd);      // request failed

    // Automatically handle downloads to prevent the system "Save As" dialog
    browserSession.removeAllListeners('will-download'); // Prevent leak on recreateView
    browserSession.on('will-download', (event, item) => {
      const activeCount = this.recentDownloads.filter(d => d.state === 'progressing').length;
      if (activeCount >= 3) {
        console.warn(`[BrowserViewManager] SECURITY: Blocked concurrent download flooding (${item.getFilename()})`);
        item.cancel();
        return;
      }

      
      // Bug fix: Sanitize filename to prevent Directory Traversal via auto-download
      // If a malicious site returns 'Content-Disposition: attachment; filename="../../.bashrc"',
      // path.basename ensures it safely lands inside the Downloads folder as '.bashrc' or similar,
      // rather than escaping into the user's home directory.
      const safeFilename = path.basename(item.getFilename() || 'downloaded_file');
      
      // Save directly to the user's Downloads folder
      const downloadPath = path.join(os.homedir(), 'Downloads', safeFilename);
      item.setSavePath(downloadPath);
      
      const downloadRecord = {
        filename: safeFilename,
        path: downloadPath,
        state: 'progressing',
        time: Date.now(),
        size: item.getTotalBytes()
      };
      this.recentDownloads.push(downloadRecord);
      // Keep only last 10 downloads to prevent memory leak
      if (this.recentDownloads.length > 10) this.recentDownloads.shift();
      
      console.log(`[BrowserViewManager] Started auto-download: ${downloadPath}`);
      
      item.once('done', (event, state) => {
        downloadRecord.state = state;
        downloadRecord.time = Date.now();
        if (state === 'completed') {
          console.log(`[BrowserViewManager] Download successfully completed: ${downloadPath}`);
        } else {
          console.error(`[BrowserViewManager] Download failed with state: ${state}`);
        }
      });
    });

    // ── Permission Auto-Grant & Security (Electron Native) ──
    // Browser permission dialogs would block the agent the same way alert() dialogs do.
    // However, for SECURITY, we strictly DENY access to the host's camera, microphone,
    // and clipboard. The agent has no eyes/ears and doesn't need them, but a malicious
    // site the agent accidentally visits could use them to spy on the human user.
    browserSession.setPermissionRequestHandler((_wc, permission, callback) => {
      if (permission === 'media' || permission === 'clipboard-read') {
        console.warn(`[BrowserViewManager] SECURITY: Auto-denied dangerous permission: ${permission}`);
        callback(false);
      } else {
        console.log(`[BrowserViewManager] Auto-granted safe permission: ${permission}`);
        callback(true);
      }
    });

    // ── Login State Monitoring (Electron Native) ──
    // When a site deletes auth cookies (logout/session expire), the agent
    // won't know until it hits a login page and wastes steps.
    // Monitor cookie removals and push a warning into consoleErrors so the
    // agent sees it in its next snapshot and can react proactively.
    browserSession.cookies.removeAllListeners('changed'); // Prevent leak on recreateView
    browserSession.cookies.on('changed', (_event: Event, cookie: Cookie, cause: string, removed: boolean) => {
      if (removed && cause !== 'overwrite') {
        // Only warn about cookies that smell like auth tokens
        const name = (cookie.name || '').toLowerCase();
        const isAuthCookie = /sess|token|auth|login|sid|jwt|csrf|_id|account/i.test(name);
        if (isAuthCookie) {
          const domain = cookie.domain || '';
          console.warn(`[BrowserViewManager] Auth cookie removed: ${cookie.name} @ ${domain} (cause: ${cause})`);
          this.pushConsoleError('warn', `Auth cookie "${cookie.name}" removed from ${domain} (${cause}) — possible logout/session expire`);
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
    // MOVED to ensureCDP() via Page.addScriptToEvaluateOnNewDocument for ultimate stealth.
    // The legacy dom-ready event was too late — anti-bot scripts in the <head>
    // would execute before dom-ready and easily detect the lack of window.chrome.

    // DO NOT addChildView here — defer until first show/navigate.
    this.attached = false;
    
    // Eagerly attach CDP so our anti-bot addScriptToEvaluateOnNewDocument runs
    // on the very first navigation.
    this.ensureCDP().catch(e => console.warn('[BrowserViewManager] Eager CDP attach failed:', getErrorMessage(e)));

    // Notify renderer on navigation events & invalidate CDP refs
    this.view.webContents.on('did-navigate', (_e, url) => {
      this.currentUrl = url;
      this.targetFrame = null;
      this.refMap.clear();   // Old backendDOMNodeIds are invalid after navigation
      this.refLabels.clear(); // Labels are stale too
      this.oopifSessions.clear(); // Old OOPIF sessions are dead after cross-origin navigation
      // BUG FIX: Old request IDs are meaningless after cross-origin nav. If not cleared,
      // waitForIdle sees inflightRequests.size > 2 and stalls for up to 15s on ghost traffic.
      this.inflightRequests.clear();
      // Cross-origin navigation may destroy the old renderer process,
      // silently invalidating CDP. Reset so ensureCDP() re-attaches on next use.
      this.cdpAttached = false;
      // Immediately re-attach CDP and re-register evasion scripts
      // BEFORE the new page's scripts execute. Without this, cross-origin
      // navigations would lose addScriptToEvaluateOnNewDocument registration.
      this.ensureCDP().catch(() => { void 0; });
      const title = this.view!.webContents.getTitle();
      this.currentTitle = title;
      this.notifyRenderer('browser-view-navigated', { url, title });
      // Clear any visual overlay — stale boxes from the previous page would
      // appear frozen over the new page content.
      this.clearOverlay().catch(() => { void 0; });
    });
    this.view.webContents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return; // Prevent iframe pushState from hijacking the main URL and clearing refs
      this.currentUrl = url;
      // SPA routing may change visible elements — stale refs could cause mis-clicks
      this.refMap.clear();
      this.refLabels.clear();
      const title = this.view!.webContents.getTitle();
      this.currentTitle = title;
      this.notifyRenderer('browser-view-navigated', { url, title });
      // Clear overlay — SPA route change renders new content, old boxes are wrong
      this.clearOverlay().catch(() => { void 0; });
    });

    // ── Navigation Protocol Guard (Security) ──
    // webSecurity stays enabled (SameSite cookies, e.g. Google login). Block file://
    // and other non-http(s) navigations — otherwise prompt injection could reach local files.
    this.view.webContents.on('will-navigate', (event, url) => {
      const lowerUrl = url.toLowerCase();

      // Intercept Userscript installations (.user.js)
      if (lowerUrl.endsWith('.user.js') && lowerUrl.startsWith('http')) {
        event.preventDefault();
        console.log(`[BrowserViewManager] Intercepted Userscript download: ${url}`);
        this.installUserscriptFromUrl(url).catch(e => console.error('[DSME] Failed to install userscript:', e));
        return;
      }

      // Only allow http/https, and file:// ONLY for our specific temp directory used by renderHTML
      const isHttp = lowerUrl.startsWith('http://') || lowerUrl.startsWith('https://') || lowerUrl.startsWith('about:blank');
      const isTempFile = lowerUrl.startsWith('file://') && lowerUrl.includes('dsme-render-');
      
      if (!isHttp && !isTempFile) {
        event.preventDefault();
        console.warn(`[BrowserViewManager] SECURITY: Blocked unauthorized navigation to: ${url}`);
        this.pushConsoleError('error', `SECURITY: Prevented unauthorized navigation to local/system protocol: ${url}`);
      }
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
        this.oopifSessions.clear(); // OOPIF sessions die when page changes
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
    // Electron fires native OS dialogs for alert/confirm/prompt.
    // This handler catches them at the engine level.
    // Confirm/prompt auto-accept; alert auto-dismiss.
    this.view.webContents.on('dialog', (event: Event, dialogInfo: { message?: string; type?: string }) => {
      event.preventDefault();
      if (dialogInfo.type === 'confirm' || dialogInfo.type === 'beforeunload') {
        event.defaultPrevented = true;
        this.pushConsoleError('warn', `[DSME] Native ${dialogInfo.type} dialog suppressed: ${String(dialogInfo.message || '').slice(0, 100)}`);
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
        this.pushConsoleError(level === 2 ? 'warn' : 'error', message.slice(0, 200));
      }
    });

    // ── Load failure detection (Electron Native) ──
    // Filter out ERR_ABORTED (-3) — fires constantly during normal redirects
    // and cancelled subresource loads. Only log real failures.
    this.view.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      if (errorCode === -3) return; // ERR_ABORTED — normal during redirects, not a real error
      console.warn(`[BrowserViewManager] Load failed: ${errorDescription} (${errorCode}) for ${validatedURL}`);
      this.pushConsoleError('error', `Page load failed: ${errorDescription} (code ${errorCode})`);
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
      this.pushConsoleError('warn', `HTTP 401 Auth required: ${authInfo.host} (realm: "${authInfo.realm}") — use browser_eval to set credentials or import auth cookies`);
      callback(); // cancel the auth dialog — agent will handle via tools
    });

    // ── Renderer Hang Detection (Electron Native) ──
    // If the renderer process becomes unresponsive (infinite loop, massive GC pause),
    // the agent would keep trying to interact with a frozen page and waste steps.
    // These events give instant awareness: agent can wait or force-reload.
    this.view.webContents.on('unresponsive', () => {
      console.error('[BrowserViewManager] Page renderer is UNRESPONSIVE (possible hang)');
      this.pushConsoleError('error', 'Page is UNRESPONSIVE — renderer may be hung. Consider waiting or reloading.');
    });
    this.view.webContents.on('responsive', () => {
      console.log('[BrowserViewManager] Page renderer recovered — responsive again');
      this.pushConsoleError('warn', 'Page recovered from unresponsive state — now interactive again.');
    });

    // ── CORS / CSP Bypass (Electron Native) ──
    // Web pages embed restrictive headers that block cross-origin API calls
    // and inline script execution. The agent needs unrestricted access to
    // ALL data on the page, including XHR responses from different origins.
    // Strip these headers at the engine level — impossible for browser extensions.
    browserSession.webRequest.onHeadersReceived((details, callback) => {
      const headers = details.responseHeaders || {};
      // webSecurity remains true; strip framing/CSP headers so embedded content and agent eval work.
      // Do not rewrite Access-Control-Allow-Origin — that breaks credentialed cross-origin requests.
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
        try { this.view.webContents.close(); } catch { void 0; }
      }
    } catch { void 0; }
    console.log('[BrowserViewManager] Recreating view...');
    // Reset ALL state before reinit — old debugger/refs/labels/errors are invalid after view destroy
    this.cdpAttached = false;
    this.cdpAttachingPromise = null;
    this.networkListenerAttached = false;
    this.recentNetworkRequests.clear();
    this.recentDownloads = [];
    this.refMap.clear();
    this.refLabels.clear();
    this.currentTitle = '';
    this.consoleErrors = [];
    // Reset inflight tracking so waitForIdle doesn't hang after crash
    this.lastNetworkActivity = 0;
    this.inflightRequests.clear();
    this.oopifSessions.clear();
    this.navigationCount = 0;
    this.targetFrame = null;
    if (this.highlightTimeout) { clearTimeout(this.highlightTimeout); this.highlightTimeout = null; }
    this.view = null;
    this.attached = false;
    this.init(this.mainWindow);
  }

  /** Clean up on app quit. */
  destroy() {
    if (this.highlightTimeout) { clearTimeout(this.highlightTimeout); this.highlightTimeout = null; }
    if (this.view) {
      try { this.view.webContents.close(); } catch { void 0; }
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
    
    const tmpFile = path.join(os.tmpdir(), `dsme-render-${Date.now()}.html`);
    try {
      await fsPromises.writeFile(tmpFile, html, 'utf8');
      await this.view!.webContents.loadFile(tmpFile);
      this.currentUrl = `file://${tmpFile}`;
      const title = this.view!.webContents.getTitle();
      this.notifyRenderer('browser-view-navigated', { url: this.currentUrl, title });
      // Clean up temp file after a delay (page is already loaded in memory)
      setTimeout(() => fsPromises.unlink(tmpFile).catch(() => { void 0; }), 5000);
      return `HTML rendered successfully. Title: ${title}`;
    } catch (e: unknown) {
      return `HTML render error: ${getErrorMessage(e)}`;
    }
  }

  // ── Navigation ──

  async navigate(url: string, _retryCount = 0): Promise<string> {
    // ── Security Guard ──
    const lowerUrl = url.toLowerCase();
    const isHttp = lowerUrl.startsWith('http://') || lowerUrl.startsWith('https://') || lowerUrl.startsWith('about:blank');
    if (!isHttp) {
      return `SECURITY ERROR: Navigation to local/system protocol "${url}" is forbidden. Agent is restricted to http/https.`;
    }

    // Proactive Process Recycling: Every 50 navigations, destroy and recreate the WebContents.
    // Since we use a persistent session ('persist:browser-panel-v2'), cookies/storage are retained,
    // but all detached DOM nodes, JS closures, and memory leaks are instantly garbage collected.
    // This provides world-class stability for agents running 1000+ step tasks.
    if (this.navigationCount > 50) {
      console.log('[BrowserViewManager] ♻️ Proactively recycling view to clear memory leaks (Process Recycling)');
      this.recreateView();
    }
    this.navigationCount++;

    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    this.ensureAttached();
    // CRITICAL: Must await CDP attachment BEFORE loadURL, otherwise the first page load
    // might execute scripts before our anti-bot evasion (addScriptToEvaluateOnNewDocument) is registered,
    // immediately exposing navigator.webdriver = true to Cloudflare/Turnstile.
    await this.ensureCDP().catch(e => console.warn('[BrowserViewManager] Eager CDP attach failed before nav:', getErrorMessage(e)));

    try {
      this.targetFrame = null; // Clear any previously focused iframe on top-level navigation
      await this.view!.webContents.loadURL(url);
      this.currentUrl = url;
      const title = this.view!.webContents.getTitle();
      this.notifyRenderer('browser-view-navigated', { url, title });
      return `Navigated to ${url}. Title: ${title}`;
    } catch (e: unknown) {
      if (getErrorMessage(e).includes('ERR_ABORTED')) {
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
      if (_retryCount < 1 && (getErrorMessage(e).includes('Cannot read properties') || getErrorMessage(e).includes('object has been destroyed'))) {
        console.error('[BrowserViewManager] WebContents in bad state, recreating and retrying...', getErrorMessage(e));
        this.recreateView();
        return this.navigate(url, _retryCount + 1);
      }
      
      return `Navigation error: ${getErrorMessage(e)}`;
    }
  }

  async goBack(): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    try {
      const nav = this.view!.webContents.navigationHistory;
      if (!nav.canGoBack()) return 'Cannot go back — no history.';

      // goBack() is async — wait for did-navigate to fire rather than sleeping
      // a fixed 1500ms (which might read the old URL if the nav is slow).
      // Cleanup function is hoisted so the timeout path can also call it
      // to prevent EventEmitter listener leaks.
      this.targetFrame = null; // Reset frame — back nav may load different content
      let cleanupFn: (() => void) | null = null;
      const navDone = new Promise<void>((resolve) => {
        cleanupFn = () => {
          this.view?.webContents.removeListener('did-navigate', cleanupFn!);
          this.view?.webContents.removeListener('did-navigate-in-page', cleanupFn!);
          resolve();
        };
        this.view!.webContents.once('did-navigate', cleanupFn);
        this.view!.webContents.once('did-navigate-in-page', cleanupFn);
      });

      nav.goBack();
      // Wait for navigation with a 5s timeout fallback.
      // On timeout, remove the once-listeners to prevent accumulation.
      await Promise.race([navDone, new Promise<void>(r => setTimeout(() => {
        if (cleanupFn) {
          this.view?.webContents.removeListener('did-navigate', cleanupFn);
          this.view?.webContents.removeListener('did-navigate-in-page', cleanupFn);
        }
        r();
      }, 5000))]);

      const url = this.view!.webContents.getURL();
      this.currentUrl = url;
      this.notifyRenderer('browser-view-navigated', { url, title: this.view!.webContents.getTitle() });
      return `Went back. Now at: ${url}`;
    } catch (e: unknown) {
      return `GoBack error: ${getErrorMessage(e)}`;
    }
  }

  async goForward(): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    try {
      const nav = this.view!.webContents.navigationHistory;
      if (!nav.canGoForward()) return 'Cannot go forward — no forward history.';

      this.targetFrame = null; // Reset frame — forward nav may load different content

      // Cleanup function is hoisted so the timeout path can also call it
      // to prevent EventEmitter listener leaks.
      let cleanupFn: (() => void) | null = null;
      const navDone = new Promise<void>((resolve) => {
        cleanupFn = () => {
          this.view?.webContents.removeListener('did-navigate', cleanupFn!);
          this.view?.webContents.removeListener('did-navigate-in-page', cleanupFn!);
          resolve();
        };
        this.view!.webContents.once('did-navigate', cleanupFn);
        this.view!.webContents.once('did-navigate-in-page', cleanupFn);
      });

      nav.goForward();
      // Wait for navigation with a 5s timeout fallback.
      // On timeout, remove the once-listeners to prevent accumulation.
      await Promise.race([navDone, new Promise<void>(r => setTimeout(() => {
        if (cleanupFn) {
          this.view?.webContents.removeListener('did-navigate', cleanupFn);
          this.view?.webContents.removeListener('did-navigate-in-page', cleanupFn);
        }
        r();
      }, 5000))]);

      const url = this.view!.webContents.getURL();
      this.currentUrl = url;
      this.notifyRenderer('browser-view-navigated', { url, title: this.view!.webContents.getTitle() });
      return `Went forward. Now at: ${url}`;
    } catch (e: unknown) {
      return `GoForward error: ${getErrorMessage(e)}`;
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

    const POLL = 50; // Ultra-fast poll (20fps) instead of 500ms
    const VISUAL_QUIET_MS = 300;
    const NETWORK_QUIET_MS = 800;
    const SPINNER_PERMANENT_MS = 3000;

    const start = Date.now();
    let spinnerStableMs = 0;
    let lastFrameTime = Date.now();
    let frameSubscriptionActive = false;
    let lastSpinnerCheck = 0;
    let lastSpinnerResult = '';

    // ── Frame-level Render Pipeline Awareness ──
    try {
      if (!this.view.webContents.isDestroyed()) {
        // Pass `true` for onlyDirty — we only need the timestamp, not the full NativeImage.
        // Without this, Chromium captures the entire viewport image every frame (~MB each).
        this.view.webContents.beginFrameSubscription(true, () => {
          lastFrameTime = Date.now();
        });
        frameSubscriptionActive = true;
      }
    } catch (e) {
       console.warn('[BrowserViewManager] beginFrameSubscription failed:', e);
    }

    const cleanup = () => {
      try {
        if (frameSubscriptionActive && this.view?.webContents && !this.view.webContents.isDestroyed()) {
          this.view.webContents.endFrameSubscription();
          frameSubscriptionActive = false;
        }
      } catch { void 0; }
    };

    const SPINNER_JS = `(()=>{
      const v=e=>{if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0;};
      for(const s of['.thinking','.generating','[data-state="streaming"]','.response-loading']){const e=document.querySelector(s);if(e&&v(e))return 'D:'+s;}
      for(const s of['[aria-busy="true"]','.loading','.spinner','.skeleton','mat-progress-spinner','[role="progressbar"]','[data-loading="true"]']){const e=document.querySelector(s);if(e&&v(e))return 'A:'+s;}
      return '';
    })()`;

    while (Date.now() - start < maxWaitMs) {
      await new Promise(r => setTimeout(r, POLL));

      // Layer 0: Page loading state — Electron Native
      if (this.view?.webContents && !this.view.webContents.isDestroyed() && this.view.webContents.isLoading()) {
        spinnerStableMs = 0;
        continue;
      }

      // Layer 1: Network quiescence (True networkidle2)
      // Allow up to 2 persistent background requests (like unclassified SSE/Long-polling).
      // If inflight > 2, or the network was active within NETWORK_QUIET_MS, wait.
      const networkAge = Date.now() - this.lastNetworkActivity;
      if (this.inflightRequests.size > 2 || (this.lastNetworkActivity > 0 && networkAge < NETWORK_QUIET_MS)) {
        spinnerStableMs = 0;
        continue;
      }

      // Layer 2: Visual Frame Sync (replaces slow DOM innerText polling)
      const visualAge = Date.now() - lastFrameTime;
      const isVisuallyIdle = frameSubscriptionActive && visualAge >= VISUAL_QUIET_MS;
      
      if (isVisuallyIdle) {
         cleanup();
         const elapsed = Date.now() - start;
         return `idle: frame sync visually stable after ${elapsed}ms`;
      }

      // Layer 3: Loading indicators (Throttled fallback for pages with constant animations/videos)
      if (Date.now() - lastSpinnerCheck > 250) {
        lastSpinnerCheck = Date.now();
        try {
          const frame = this.getExecutionFrame();
          if (frame) lastSpinnerResult = await frame.executeJavaScriptInIsolatedWorld(999, [{ code: SPINNER_JS }]);
        } catch { lastSpinnerResult = ''; }
      }

      if (lastSpinnerResult.startsWith('D:')) {
        continue; // Definite indicator (AI generating) — MUST keep waiting
      }

      if (lastSpinnerResult.startsWith('A:')) {
        spinnerStableMs += POLL;
        if (spinnerStableMs >= SPINNER_PERMANENT_MS) {
          cleanup();
          const elapsed = Date.now() - start;
          const indicator = lastSpinnerResult.slice(2);
          return `idle: network quiet after ${elapsed}ms (${indicator} appears permanent)`;
        }
        continue;
      }

      // Layer 4: Network deeply quiet fallback
      // If the page is continuously painting (e.g. a carousel or blinking cursor) but network is silent
      if (this.inflightRequests.size <= 2 && networkAge >= NETWORK_QUIET_MS * 2) {
         cleanup();
         const elapsed = Date.now() - start;
         return `idle: network deeply quiet (animations present) after ${elapsed}ms`;
      }
    }

    cleanup();
    const networkAge = Date.now() - this.lastNetworkActivity;
    if (this.lastNetworkActivity > 0 && networkAge < NETWORK_QUIET_MS) {
      return `timeout: network still active after ${maxWaitMs}ms`;
    }
    return `timeout: visual frames still changing after ${maxWaitMs}ms`;
  }

  // ── Script execution ──

  /** Get the frame to run scripts on (respects targetFrame if set). */
  private getExecutionFrame(): WebFrameMain | null {
    if (!this.view || !this.view.webContents || this.view.webContents.isDestroyed()) return null;
    if (this.targetFrame) {
      // Validate the frame is still alive
      try {
        void this.targetFrame.url; // throws if frame is destroyed
        return this.targetFrame;
      } catch {
        console.warn('[BrowserViewManager] Target frame destroyed, falling back to mainFrame');
        this.targetFrame = null;
      }
    }
    return this.view.webContents.mainFrame;
  }

  async executeJS(script: string, timeoutMs = 600_000, isolatedWorld = true): Promise<string> {
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
        isolatedWorld
          ? frame.executeJavaScriptInIsolatedWorld(999, [{ code: finalScript }])
          : frame.executeJavaScript(finalScript),
        timeoutPromise
      ]).finally(() => clearTimeout(timer));
      
      const val = result;
      if (val === null || val === undefined) {
        try {
          const fallback = await (isolatedWorld
            ? frame.executeJavaScriptInIsolatedWorld(999, [{ code: `document.body?.innerText?.slice(0, 8000) || ''` }])
            : frame.executeJavaScript(`document.body?.innerText?.slice(0, 8000) || ''`));
          if (fallback && typeof fallback === 'string' && fallback.length > 10) {
            return fallback;
          }
        } catch { void 0; }
        return 'Script completed but returned no value. Use `return` to return data.';
      }
      return typeof val === 'string' ? val : JSON.stringify(val);
    } catch (e: unknown) {
      return `Script error: ${getErrorMessage(e)}`;
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
  async executeJSAllFrames(script: string, timeoutMs = 15_000, isolatedWorld = true): Promise<{ frameIndex: number; frameUrl: string; result: string }[]> {
    if (!this.ensureHealthyView()) return [];
    const results: { frameIndex: number; frameUrl: string; result: string }[] = [];
    let idx = 0;

    const walkFrames = async (frame: WebFrameMain) => {
      const currentIdx = idx++;
      try {
        let timer: NodeJS.Timeout;
        const result = await Promise.race([
          isolatedWorld
            ? frame.executeJavaScriptInIsolatedWorld(999, [{ code: script }])
            : frame.executeJavaScript(script),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
          }),
        ]).finally(() => clearTimeout(timer!));
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
      
      // Initialize start position if this is the first move
      if (this.lastMouseX === -1) {
        this.lastMouseX = this.bounds.width / 2;
        this.lastMouseY = this.bounds.height / 2;
      }
      
      const startX = this.lastMouseX;
      const startY = this.lastMouseY;
      
      // Generate Bezier path to simulate human movement
      const steps = 15 + Math.floor(Math.random() * 15);
      // Clamp control points to view bounds — unclamped points can go negative or
      // beyond viewport, causing Chromium to clip coordinates and producing an
      // obviously non-human edge-sticking trajectory that anti-bot systems detect.
      const clampX = (v: number) => Math.max(1, Math.min(Math.round(v), this.bounds.width - 1));
      const clampY = (v: number) => Math.max(1, Math.min(Math.round(v), this.bounds.height - 1));
      const ctrl1X = startX + (cx - startX) * 0.3 + (Math.random() - 0.5) * 100;
      const ctrl1Y = startY + (cy - startY) * 0.3 + (Math.random() - 0.5) * 100;
      const ctrl2X = startX + (cx - startX) * 0.7 + (Math.random() - 0.5) * 100;
      const ctrl2Y = startY + (cy - startY) * 0.7 + (Math.random() - 0.5) * 100;
      
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        const ptX = clampX(u*u*u*startX + 3*u*u*t*ctrl1X + 3*u*t*t*ctrl2X + t*t*t*cx);
        const ptY = clampY(u*u*u*startY + 3*u*u*t*ctrl1Y + 3*u*t*t*ctrl2Y + t*t*t*cy);
        wc.sendInputEvent({ type: 'mouseMove', x: ptX, y: ptY } as WebContentsInputEvent);
        
        // Ease-out delay: slow down as it approaches target
        const delay = 10 + (t * t * 20) + (Math.random() * 10);
        await new Promise(r => setTimeout(r, delay));
      }
      
      // Final adjustment & pause before clicking
      wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy } as WebContentsInputEvent);
      this.lastMouseX = cx;
      this.lastMouseY = cy;
      await new Promise(r => setTimeout(r, 60 + Math.random() * 80));

      wc.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 } as WebContentsInputEvent);
      await new Promise(r => setTimeout(r, 40 + Math.random() * 50)); // Human click hold time
      wc.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 } as WebContentsInputEvent);
      return `Native click at (${cx}, ${cy}) with humanized Bezier trajectory`;
    } catch (e: unknown) {
      return `Native click error: ${getErrorMessage(e)}`;
    }
  }

  /**
   * Hover over an element using Electron's native `sendInputEvent`.
   * This is crucial for triggering CSS `:hover` states and JS `mouseenter` events
   * to reveal dropdown menus or tooltips.
   */
  async hover(ref: string): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    // Bounds check — same guard as nativeMouseClick
    if (this.bounds.width < 10 || this.bounds.height < 10) {
      return 'Error: view bounds too small — is the browser panel visible?';
    }
    const center = await this.getElementCenterByCDP(ref);
    if (!center) return `Error: Cannot find element [${ref}] on screen.`;
    
    const wc = this.view!.webContents;
    // BUG FIX: getElementCenterByCDP returns { x, y, label }, NOT { cx, cy }
    const cx = Math.max(1, Math.min(Math.round(center.x), this.bounds.width - 1));
    const cy = Math.max(1, Math.min(Math.round(center.y), this.bounds.height - 1));
    
    // Simulate real mouse movement towards the target
    const currentX = this.lastMouseX >= 0 ? this.lastMouseX : cx;
    const currentY = this.lastMouseY >= 0 ? this.lastMouseY : cy;
    
    if (this.lastMouseX >= 0 && this.lastMouseY >= 0) {
      // Interpolate 3 steps (round to integers — sub-pixel floats are a bot fingerprint)
      for (let i = 1; i <= 3; i++) {
        const ptX = Math.round(currentX + (cx - currentX) * (i / 3));
        const ptY = Math.round(currentY + (cy - currentY) * (i / 3));
        wc.sendInputEvent({ type: 'mouseMove', x: ptX, y: ptY } as WebContentsInputEvent);
        await new Promise(r => setTimeout(r, 16));
      }
    }
    
    wc.sendInputEvent({ type: 'mouseMove', x: cx, y: cy } as WebContentsInputEvent);
    this.lastMouseX = cx;
    this.lastMouseY = cy;
    
    // Trigger paint layout for hover effects
    await new Promise(r => setTimeout(r, 100));
    
    return `Hovered over element [${ref}]. Wait a moment for any dropdowns/tooltips to appear before taking snapshot.`;
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
    } as WebContentsInputEvent);
  }



  // ── Native input (engine-level, bypasses TrustedHTML / CSP) ──

  /**
   * Insert text at the currently focused element using Chromium's native input path.
   * By inserting the entire string at once, this perfectly mimics a human "Paste" action
   * (Cmd+V / Ctrl+V), which natively fires a single 'input' event without 'keydown'/'keyup'.
   * This avoids the critical anti-bot fingerprint of "typing delays without keystroke events".
   * Works with contenteditable, input, textarea, and rich text editors.
   */
  async insertText(text: string): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    try {
      const wc = this.view!.webContents;
      // Brief human hesitation before pasting
      await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
      
      // Insert the entire text at once (mimics Paste)
      await wc.insertText(text);
      
      // Brief pause after pasting to let React/Vue state update
      await new Promise(r => setTimeout(r, 50));
      
      return `Inserted (pasted) ${text.length} characters`;
    } catch (e: unknown) {
      return `insertText error: ${getErrorMessage(e)}`;
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
      wc.sendInputEvent({ type: 'keyDown', keyCode } as WebContentsInputEvent);
      wc.sendInputEvent({ type: 'keyUp', keyCode } as WebContentsInputEvent);
      return `Pressed key: ${key}`;
    } catch (e: unknown) {
      return `pressKey error: ${getErrorMessage(e)}`;
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
    } catch (e: unknown) {
      console.warn('[BrowserViewManager] captureScreenshot failed:', getErrorMessage(e));
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

  // ── Session Time-Machine & Memory ──
  
  private sessionSnapshots = new Map<string, {
    url: string;
    cookies: Electron.Cookie[];
    localStorage: string;
    sessionStorage: string;
  }>();

  /**
   * Create a memory snapshot of the current browser state (URL, Cookies, LocalStorage, SessionStorage).
   * This enables Tree-of-Thoughts (ToT) exploration: if an action fails, AI can instantly rollback.
   */
  async snapshotState(): Promise<string> {
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    const id = `snap_${Date.now()}`;
    try {
      const url = this.view!.webContents.getURL();
      const cookies = await this.exportCookies();
      
      const frame = this.getExecutionFrame() || this.view!.webContents.mainFrame;
      // Note: localStorage is tied to origin, so it's shared between main world and isolated world
      const storageResult = await frame.executeJavaScriptInIsolatedWorld(999, [{ code: `
        JSON.stringify({
          local: Object.entries(localStorage),
          session: Object.entries(sessionStorage)
        })
      ` }]);
      const parsed = JSON.parse(storageResult);

      this.sessionSnapshots.set(id, {
        url,
        cookies,
        localStorage: JSON.stringify(parsed.local),
        sessionStorage: JSON.stringify(parsed.session)
      });
      
      // Prevent memory leaks from accumulating snapshots
      while (this.sessionSnapshots.size > 20) {
        const oldest = this.sessionSnapshots.keys().next().value;
        if (oldest) this.sessionSnapshots.delete(oldest);
        else break;
      }
      
      return id;
    } catch (e: unknown) {
      return `Error creating snapshot: ${getErrorMessage(e)}`;
    }
  }

  /**
   * Restore a previously created snapshot.
   * Clears current state, restores cookies & storage, and navigates back to the exact URL.
   */
  async restoreState(id: string): Promise<string> {
    if (!this.sessionSnapshots.has(id)) return `Error: Snapshot ${id} not found`;
    if (!this.ensureHealthyView()) return 'Error: view not initialized';
    
    try {
      const snap = this.sessionSnapshots.get(id)!;
      
      // 1. Wipe current state clean
      const browserSession = session.fromPartition('persist:browser-panel-v2');
      await browserSession.clearStorageData(); 
      
      // 2. Restore Cookies (Electron Native)
      await this.importCookies(snap.cookies);
      
      // 3. Navigate back — wait for did-navigate event (not a fixed timeout)
      // Cleanup function is hoisted so the timeout path can remove listeners.
      let onNav: (() => void) | null = null;
      const navDone = new Promise<void>((resolve) => {
        onNav = () => {
          this.view?.webContents.removeListener('did-navigate', onNav!);
          this.view?.webContents.removeListener('did-navigate-in-page', onNav!);
          resolve();
        };
        this.view!.webContents.once('did-navigate', onNav);
        this.view!.webContents.once('did-navigate-in-page', onNav);
      });
      await this.view!.webContents.loadURL(snap.url);
      // Wait for navigation with a 5s timeout fallback.
      // On timeout, remove the once-listeners to prevent accumulation.
      await Promise.race([navDone, new Promise<void>(r => setTimeout(() => {
        if (onNav) {
          this.view?.webContents.removeListener('did-navigate', onNav);
          this.view?.webContents.removeListener('did-navigate-in-page', onNav);
        }
        r();
      }, 5000))]);

      // 4. Restore Local/Session Storage
      // snap.localStorage is a JSON string (e.g. '[["key","value"]]').
      // Interpolating it directly into the script is safe because JSON is valid JS syntax,
      // and JSON.stringify inherently escapes all quotes and backslashes properly.
      const frame = this.view!.webContents.mainFrame;
      await frame.executeJavaScriptInIsolatedWorld(999, [{ code: `
        try {
          const local = ${snap.localStorage};
          const session = ${snap.sessionStorage};
          localStorage.clear();
          sessionStorage.clear();
          for (const [k, v] of local) localStorage.setItem(k, v);
          for (const [k, v] of session) sessionStorage.setItem(k, v);
        } catch(e) {}
      ` }]);
      
      // 5. Reload to apply restored storage (React/Vue hydration)
      this.view!.webContents.reload();
      
      return `Successfully rolled back to state ${id} and navigated to ${snap.url}`;
    } catch (e: unknown) {
      return `Error restoring snapshot: ${getErrorMessage(e)}`;
    }
  }

  // ── Cookie / Session Management (Electron Native) ──

  /**
   * Export all cookies for the browser session.
   * Use this to persist login state across app restarts.
   * No browser extension can do this — they only get cookies for their own domain.
   */
  async exportCookies(): Promise<Electron.Cookie[]> {
    const browserSession = session.fromPartition('persist:browser-panel-v2');
    return browserSession.cookies.get({});
  }

  /**
   * Export cookies for a specific URL (e.g. just Google or just 126.com).
   */
  async getCookiesForUrl(url: string): Promise<Electron.Cookie[]> {
    const browserSession = session.fromPartition('persist:browser-panel-v2');
    return browserSession.cookies.get({ url });
  }

  /**
   * Import cookies — restore a previously saved session.
   * Agent can log in once, export cookies, and restore them next time.
   */
  async importCookies(cookies: Array<{ name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; expirationDate?: number }>): Promise<string> {
    const browserSession = session.fromPartition('persist:browser-panel-v2');
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
      } catch (e: unknown) {
        console.warn(`[BrowserViewManager] Failed to import cookie ${c.name}:`, getErrorMessage(e));
      }
    }
    return `Imported ${imported}/${cookies.length} cookies`;
  }

  /**
   * Clear all cookies and storage for the browser session.
   */
  async clearSession(): Promise<string> {
    const browserSession = session.fromPartition('persist:browser-panel-v2');
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
      // Clear any pending search listeners to prevent race conditions
      // from rapid successive calls resolving each other's promises.
      wc.removeAllListeners('found-in-page');

      // found-in-page fires for each match found; finalUpdate=true means search is complete
      const handler = (_event: Event, result: { finalUpdate?: number; matches?: number }) => {
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
    const fp = outputPath || path.join(os.homedir(), 'Downloads', `page_${Date.now()}.pdf`);
    try {
      const data = await this.view!.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        preferCSSPageSize: true,
      });
      await fsPromises.mkdir(path.dirname(fp), { recursive: true });
      await fsPromises.writeFile(fp, data);
      return `PDF saved to ${fp} (${Math.round(data.length / 1024)}KB)`;
    } catch (e: unknown) {
      return `PDF export error: ${getErrorMessage(e)}`;
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
    } catch (e: unknown) {
      return `Clipboard read error: ${getErrorMessage(e)}`;
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
    } catch (e: unknown) {
      return `Clipboard write error: ${getErrorMessage(e)}`;
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
    const refData = this.refMap.get(ref);
    if (!refData) return `Error: ref ${ref} not found. Run browser_snapshot first.`;
    if (!await this.ensureCDP()) return 'Error: CDP not available';
    const { backendNodeId, frameId } = refData;
    const sessionId = frameId ? this.oopifSessions.get(frameId) : undefined;

    try {
      await this.cdpCommand('DOM.setFileInputFiles', {
        files: filePaths,
        backendNodeId,
      }, 1, sessionId);
      return `Set ${filePaths.length} file(s) on [${ref}]: ${filePaths.map(f => f.split('/').pop()).join(', ')}`;
    } catch (e: unknown) {
      return `File upload error: ${getErrorMessage(e)}`;
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
        let targetSessionId: string | undefined = undefined;
        const viewRef = this.view!; // Capture ref to detect destruction

        const cleanup = () => {
          debugger_.removeListener('message', handler);
          clearTimeout(timer);
        };

        const handler = async (_event: Event, method: string, params: JsonObject, sessionId: string) => {
          if (settled) return;
          // Guard: if view was destroyed (crash/recreate), clean up immediately
          if (viewRef.webContents.isDestroyed()) {
            settled = true;
            cleanup();
            resolve('Network capture aborted: view was destroyed.');
            return;
          }

          if (method === 'Network.responseReceived') {
            const url: string = params.response?.url || '';
            if (url.includes(urlPattern) && !targetRequestId) {
              targetRequestId = params.requestId;
              targetUrl = url;
              targetSessionId = sessionId;
            }
          } else if (method === 'Network.loadingFinished' && targetRequestId === params.requestId) {
            settled = true;
            cleanup();
            try {
              const { body, base64Encoded } = await this.cdpCommand(
                'Network.getResponseBody',
                { requestId: targetRequestId },
                1,
                targetSessionId
              );
              const content = base64Encoded
                ? Buffer.from(body, 'base64').toString('utf-8')
                : body;
              const preview = content.length > 50000
                ? content.slice(0, 50000) + '\n...(truncated)'
                : content;
              resolve(`Captured response from ${targetUrl} (${content.length} chars):\n${preview}`);
            } catch (e: unknown) {
              resolve(`Matched ${targetUrl} but failed to read body: ${getErrorMessage(e)}`);
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
    } catch (e: unknown) {
      return `Network capture error: ${getErrorMessage(e)}`;
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
    // Coalesce concurrent callers onto a single attach operation.
    // Without this, did-navigate's ensureCDP() and navigate's ensureCDP()
    // would race into debugger.attach() simultaneously, causing "Already attached" noise.
    if (this.cdpAttachingPromise) return this.cdpAttachingPromise;
    this.cdpAttachingPromise = this._doAttachCDP();
    try {
      return await this.cdpAttachingPromise;
    } finally {
      this.cdpAttachingPromise = null;
    }
  }

  private async _doAttachCDP(): Promise<boolean> {
    if (!this.view || this.view.webContents.isDestroyed()) return false;
    try {
      this.view.webContents.debugger.attach('1.3');
      this.cdpAttached = true;
      
      // Use raw sendCommand (not this.cdpCommand) to avoid
      // ensureCDP → cdpCommand → ensureCDP recursion.
      const send = (m: string, p?: JsonObject) => this.view!.webContents.debugger.sendCommand(m, p);
      send('Network.enable').catch(() => { void 0; });
      
      const CHROME_VERSION = '131';
      const EVASION_SCRIPT = `
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
        } catch { void 0; }

        // 2. window.chrome
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.app) {
          window.chrome.app = {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
          };
        }
        if (!window.chrome.runtime) {
          window.chrome.runtime = { 
            OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
            OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
            PlatformArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
            RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
            connect: () => {}, 
            sendMessage: () => {}, 
            id: undefined 
          };
        }
        window.chrome.csi = () => ({});
        window.chrome.loadTimes = () => ({});

        // 3. navigator.plugins
        try {
          Object.defineProperty(navigator, 'plugins', {
            get: () => [
              { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
              { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: 'Portable Document Format' },
              { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
            ]
          });
        } catch { void 0; }

        // 4. Remove Electron fingerprints
        try {
          delete window.process; delete window.require; delete window.module;
          delete window.exports; delete window.__electron_preload;
        } catch { void 0; }

        // 5. navigator.webdriver
        try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch { void 0; }

        // 6. Eradicate CDP variables (cdc_...)
        try {
          let keys = Object.getOwnPropertyNames(window);
          for (let i = 0; i < keys.length; i++) {
            if (keys[i].startsWith('cdc_')) {
              delete window[keys[i]];
            }
          }
          let docKeys = Object.getOwnPropertyNames(document);
          for (let i = 0; i < docKeys.length; i++) {
            if (docKeys[i].startsWith('cdc_')) {
              delete document[docKeys[i]];
            }
          }
        } catch { void 0; }
        // Cleaned up over-engineered proxies that Google BotGuard detects via iframe escapes.
      `;

      // ── Load Userscripts ──
      let userscriptInjection = '';
      try {
        const configPath = path.join(app.getPath('userData'), 'dsme-config.json');
        const configRaw = await fsPromises.readFile(configPath, 'utf8').catch(() => null);
        if (configRaw) {
          const config = JSON.parse(configRaw) as { userscripts?: { enabled?: boolean; match?: string; name?: string; code?: string }[] };
          if (config.userscripts && Array.isArray(config.userscripts)) {
            config.userscripts.filter((s) => s.enabled).forEach((s) => {
              // Split multiple matches (e.g., separated by comma) and convert each glob to regex
              const matchPatterns = (s.match || '').split(',').map((m: string) => m.trim()).filter(Boolean);
              const matchRegexes = matchPatterns.map((pat: string) => {
                return '^' + pat
                  .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape regex chars
                  .replace(/\\\*/g, '.*') + '$'; // Convert * to .*
              });
              const combinedRegexStr = matchRegexes.join('|');
              
              userscriptInjection += `
                if (new RegExp(${JSON.stringify(combinedRegexStr)}).test(window.location.href)) {
                  try {
                    console.log('[Tampermonkey] Running script:', ${JSON.stringify(s.name)});
                    ${s.code}
                  } catch(e) {
                    console.error('[Tampermonkey] Script error in ' + ${JSON.stringify(s.name)} + ':', e);
                  }
                }
              `;
            });
          }
        }
      } catch (e) {
        console.warn('[DSME] Failed to load userscripts:', e);
      }

      const FINAL_INJECTION = EVASION_SCRIPT + '\n' + userscriptInjection;

      // Inject anti-bot evasion and dialog suppression into EVERY frame BEFORE page scripts run.
      // We MUST await these to ensure the registry is armed before any navigation completes.
      await send('Page.enable');
      await send('Page.addScriptToEvaluateOnNewDocument', { source: FINAL_INJECTION });
      
      // Handle cross-origin Out-of-Process Iframes (OOPIFs)
      // Site Isolation means cross-origin iframes run in separate processes.
      // To inject evasion into them, we MUST auto-attach and intercept their creation.
      // NOTE: Isolated from Page.enable/addScript — if setAutoAttach fails (e.g. target
      // doesn't support it), we still want ensureCDP to succeed since evasion IS registered.
      await send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true, // Pause child target to inject evasion before any JS runs
        flatten: true
      }).catch(e => console.warn('[DSME] Target.setAutoAttach failed (non-fatal):', getErrorMessage(e)));

      if (!this.networkListenerAttached) {
        this.networkListenerAttached = true;
        this.view.webContents.debugger.on('message', (_event, method, params, sessionId) => {
          if (method === 'Target.attachedToTarget') {
            const childSid = params.sessionId;
            const targetInfo = params.targetInfo || {};
            const targetId = targetInfo.targetId;
            const targetType = targetInfo.type; // "page", "iframe", "worker", "service_worker", etc.
            
            if (targetId) this.oopifSessions.set(targetId, childSid);

            // In flatten mode, route commands to child via sessionId (3rd arg).
            const childSend = (m: string, p?: JsonObject) =>
              this.view!.webContents.debugger.sendCommand(m, p, childSid);
            
            // Only inject evasion scripts into DOM-bearing targets (page/iframe).
            // Workers do not have a Page domain and would throw on Page.enable.
            if (targetType === 'page' || targetType === 'iframe') {
              childSend('Page.enable')
                .then(() => childSend('Page.addScriptToEvaluateOnNewDocument', { source: FINAL_INJECTION }))
                .catch(e => console.warn(`[DSME] OOPIF injection failed for ${targetType}:`, getErrorMessage(e)))
                .finally(() => childSend('Runtime.runIfWaitingForDebugger').catch(() => { void 0; }));
            } else {
              // For all other targets (workers, etc.), just release the debugger pause immediately.
              // Failing to do this permanently freezes all Web Workers on the site.
              childSend('Runtime.runIfWaitingForDebugger').catch(() => { void 0; });
            }
          }
          if (method === 'Target.detachedFromTarget') {
            const targetId = params.targetId;
            if (targetId) this.oopifSessions.delete(targetId);
            else {
              for (const [tId, sId] of this.oopifSessions.entries()) {
                if (sId === params.sessionId) { this.oopifSessions.delete(tId); break; }
              }
            }
          }
          if (method === 'Network.responseReceived') {
            const url = params.response?.url || '';
            const mimeType = params.response?.mimeType || '';
            // Only track JSON or API-like requests
            if (url.startsWith('http') && (mimeType.includes('application/json') || mimeType.includes('text/plain') || url.includes('/api/') || url.includes('graphql'))) {
              this.recentNetworkRequests.set(params.requestId, {
                url,
                method: params.response?.requestHeaders?.[':method'] || params.response?.requestHeaders?.['Method'] || 'GET',
                mimeType,
                status: params.response?.status || 0,
                timestamp: Date.now(),
                sessionId
              });
              // Keep map size reasonable (last 50 requests)
              if (this.recentNetworkRequests.size > 50) {
                const oldest = this.recentNetworkRequests.keys().next().value;
                if (oldest) this.recentNetworkRequests.delete(oldest);
              }
            }
          }
        });
      }

      // Bug fix #2: Use removeAllListeners+once to prevent accumulating detach listeners
      // across multiple attach/detach cycles (e.g. page navigations).
      this.view.webContents.debugger.removeAllListeners('detach');
      this.view.webContents.debugger.once('detach', () => {
        this.cdpAttached = false;
        this.refMap.clear();    // Refs are invalid after detach
        this.refLabels.clear(); // Labels are stale too
      });
      return true;
    } catch (e: unknown) {
      if (getErrorMessage(e).includes('Already attached')) {
        this.cdpAttached = true;
        return true;
      }
      console.warn('[BrowserViewManager] CDP attach failed:', getErrorMessage(e));
      return false;
    }
  }

  /** Send a CDP command. Auto-retries once if the target detached asynchronously (process swap). */
  async cdpCommand(method: string, params?: JsonObject, retries = 1, sessionId?: string): Promise<unknown> {
    if (!this.view || this.view.webContents.isDestroyed()) {
      throw new Error('CDP not attached: view destroyed');
    }
    
    // Ensure we are attached before attempting
    await this.ensureCDP();

    try {
      // CRITICAL: Wrap sendCommand in a 30s timeout.
      // If Chromium's renderer is hung or the OOPIF session is stale,
      // sendCommand can await its internal Promise forever, deadlocking the Agent.
      let timer: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`CDP command '${method}' timed out after 30s`)), 30_000);
      });
      const result = await Promise.race([
        this.view.webContents.debugger.sendCommand(method, params, sessionId),
        timeoutPromise
      ]).finally(() => clearTimeout(timer!));
      return result;
    } catch (e: unknown) {
      if (retries > 0 && (getErrorMessage(e).includes('not attached') || getErrorMessage(e).includes('timed out'))) {
        // Race condition or hang: target detached asynchronously after ensureCDP, or command hung.
        // Force state reset, wait a bit for Electron to settle, and retry.
        this.cdpAttached = false;
        try { this.view.webContents.debugger.detach(); } catch { void 0; }
        await new Promise(r => setTimeout(r, 100));
        return this.cdpCommand(method, params, retries - 1, sessionId);
      }
      throw e;
    }
  }

  /** Detach CDP debugger (cleanup). */
  detachCDP(): void {
    if (this.cdpAttached && this.view && !this.view.webContents.isDestroyed()) {
      try { this.view.webContents.debugger.detach(); } catch { void 0; }
    }
    this.cdpAttached = false;
    // Do NOT set this.networkListenerAttached = false here!
    // The 'message' listener remains on the debugger object for the lifetime of the view.
  }

  // ── Network MITM Methods ──

  async showIntentOverlay(text: string): Promise<void> {
    if (!this.ensureHealthyView()) return;
    const escaped = text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
    const HUD_JS = `
      try {
        let root = document.getElementById('dsme-intent-root');
        if (!root) {
          root = document.createElement('div');
          root.id = 'dsme-intent-root';
          root.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;';
          document.documentElement.appendChild(root);
          
          const shadow = root.attachShadow({ mode: 'open' });
          const style = document.createElement('style');
          style.textContent = \`
            @keyframes pulse-glow {
              0% { box-shadow: 0 0 15px rgba(0,255,204,0.1), inset 0 0 10px rgba(0,255,204,0.05); }
              50% { box-shadow: 0 0 25px rgba(0,255,204,0.3), inset 0 0 20px rgba(0,255,204,0.1); }
              100% { box-shadow: 0 0 15px rgba(0,255,204,0.1), inset 0 0 10px rgba(0,255,204,0.05); }
            }
            @keyframes slide-up {
              from { transform: translateY(20px) scale(0.95); opacity: 0; }
              to { transform: translateY(0) scale(1); opacity: 1; }
            }
            .hud-container {
              background: linear-gradient(135deg, rgba(12, 16, 24, 0.85) 0%, rgba(5, 8, 12, 0.95) 100%);
              border: 1px solid rgba(0, 255, 204, 0.4);
              border-top: 1px solid rgba(0, 255, 204, 0.8);
              border-radius: 16px;
              padding: 16px 32px;
              color: #00ffcc;
              font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
              font-size: 15px;
              font-weight: 500;
              letter-spacing: 0.5px;
              backdrop-filter: blur(12px) saturate(150%);
              -webkit-backdrop-filter: blur(12px) saturate(150%);
              text-align: center;
              max-width: 90vw;
              min-width: 320px;
              word-wrap: break-word;
              animation: slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards, pulse-glow 3s infinite ease-in-out;
              position: relative;
              overflow: hidden;
            }
            .hud-container::before {
              content: '';
              position: absolute;
              top: 0; left: 0; right: 0; height: 1px;
              background: linear-gradient(90deg, transparent, rgba(0, 255, 204, 1), transparent);
            }
            .hud-title {
              color: #a0aec0;
              font-size: 11px;
              text-transform: uppercase;
              letter-spacing: 2px;
              margin-bottom: 8px;
              display: flex;
              align-items: center;
              justify-content: center;
              gap: 8px;
            }
            .hud-title::before {
              content: '';
              display: inline-block;
              width: 8px;
              height: 8px;
              border-radius: 50%;
              background: #00ffcc;
              box-shadow: 0 0 8px #00ffcc;
            }
            .hud-content {
              text-shadow: 0 0 10px rgba(0, 255, 204, 0.5);
              line-height: 1.5;
            }
          \`;
          shadow.appendChild(style);
          
          const container = document.createElement('div');
          container.className = 'hud-container';
          container.id = 'hud-content-box';
          shadow.appendChild(container);
        }
        
        const shadow = root.shadowRoot;
        const container = shadow.getElementById('hud-content-box');
        
        // Re-trigger animation
        container.style.animation = 'none';
        container.offsetHeight; /* trigger reflow */
        container.style.animation = 'slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards, pulse-glow 3s infinite ease-in-out';
        
        container.innerHTML = \`
          <div class="hud-title">DSME Cognitive Engine</div>
          <div class="hud-content">\${ \`${escaped}\` }</div>
        \`;
      } catch(e) {}
    `;
    try {
      const frame = this.getExecutionFrame() || this.view!.webContents.mainFrame;
      await frame.executeJavaScriptInIsolatedWorld(999, [{ code: HUD_JS }]);
    } catch { void 0; }
  }

  listRecentNetworkRequests() {
    const list = Array.from(this.recentNetworkRequests.entries()).map(([id, req]) => {
      return `[ID: ${id}] ${req.method} ${req.url.slice(0, 150)} (${req.status}, ${req.mimeType})`;
    });
    return list.length ? list.join('\n') : 'No recent API/JSON requests found.';
  }

  async getNetworkResponseBody(requestId: string): Promise<string> {
    const req = this.recentNetworkRequests.get(requestId);
    if (!req) return `Error: request ID ${requestId} not found or expired.`;
    if (!await this.ensureCDP()) return 'Error: CDP not attached';
    try {
      const { body, base64Encoded } = await this.cdpCommand('Network.getResponseBody', { requestId }, 1, req.sessionId);
      const content = base64Encoded ? Buffer.from(body, 'base64').toString('utf-8') : body;
      return content.length > 50000 ? content.slice(0, 50000) + '\n...(truncated)' : content;
    } catch (e: unknown) {
      if (getErrorMessage(e).includes('No resource with given identifier')) {
         return `Error: Response body for ${requestId} has been garbage collected by Chromium. Try capturing it earlier.`;
      }
      return `Error retrieving response body: ${getErrorMessage(e)}`;
    }
  }

  // ── Download API ──
  
  listRecentDownloads(): string {
    if (this.recentDownloads.length === 0) return 'No recent downloads found in this session.';
    return this.recentDownloads.map((d, i) => 
      `[${i}] ${d.filename} (State: ${d.state}, Size: ${d.size ? Math.round(d.size/1024) + ' KB' : 'Unknown'}) -> ${d.path}`
    ).join('\n');
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
      await this.cdpCommand('DOM.enable').catch(() => { void 0; });
      
      const { frameTree } = await this.cdpCommand('Page.getFrameTree') as { frameTree: FrameTreeNode };
      const collectFrames = (tree: FrameTreeNode) => {
        allFrameIds.push({ id: tree.frame.id, url: tree.frame.url || '' });
        if (tree.childFrames) {
          for (const child of tree.childFrames) collectFrames(child);
        }
      };
      collectFrames(frameTree);
    } catch (e: unknown) {
      console.warn('[BrowserViewManager] Page.getFrameTree failed, falling back to main frame only:', getErrorMessage(e));
      allFrameIds.push({ id: '', url: this.getUrl() }); // empty id = no frameId param = main frame
    }

    // Step 2: Collect AX nodes from ALL frames CONCURRENTLY
    let allNodes: AxNode[] = [];
    const frameUrlMap = new Map<string, string>(); // frameId → URL for annotation

    const framePromises = allFrameIds.map(async (frame) => {
      try {
        const sessionId = frame.id ? this.oopifSessions.get(frame.id) : undefined;
        // When querying an OOPIF directly via its sessionId, we do not pass frameId.
        // It acts as the main frame for that specific Target session.
        const axParams: JsonObject = { depth: -1 };
        if (!sessionId && frame.id) axParams.frameId = frame.id;

        let timer: NodeJS.Timeout;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('AXTree timeout')), 15000);
        });

        const { nodes } = await Promise.race([
          this.cdpCommand('Accessibility.getFullAXTree', axParams, 1, sessionId),
          timeoutPromise
        ]).finally(() => clearTimeout(timer!)) as { nodes: AxNode[] };
        // Tag each node with its frame URL for output annotation
        for (const node of nodes) {
          node._frameUrl = frame.url;
          node._frameId = frame.id;
        }
        return { frame, nodes };
      } catch (e: unknown) {
        console.warn(`[BrowserViewManager] AXTree failed for frame ${frame.id || 'main'}:`, getErrorMessage(e));
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
    const formatted = formatAxSnapshot({
      title: this.getTitle(),
      url: this.getUrl(),
      nodes: allNodes,
      interactiveRoles: BrowserViewManager.INTERACTIVE_ROLES,
      recentErrors: this.consoleErrors,
    });

    const d = formatted.diagnostics;
    console.log(
      `[BrowserViewManager] CDP AXTree: ${d.totalNodes} nodes (${d.ignoredNodes} ignored), `
      + `${d.interactiveWithBackendId} interactive+backendId, ${d.interactiveWithoutBackendId} interactive-NO-backendId, `
      + `refs=${d.refCount}. Top roles: ${d.topRoles}`,
    );

    this.refMap = formatted.refMap;
    this.refLabels = formatted.refLabels;
    return formatted.text;
  }

  /**
   * Get element center coordinates using CDP DOM.getContentQuads.
   * Returns viewport-absolute coordinates suitable for nativeMouseClick().
   * Works cross-frame — no need to compute iframe offsets manually.
   */
  async getElementCenterByCDP(ref: string): Promise<{ x: number; y: number; label: string } | null> {
    const refData = this.refMap.get(ref);
    if (!refData) {
      // Ref not found — could mean page state changed after last snapshot.
      // Caller should re-run browser_snapshot to refresh refs.
      return null;
    }
    const { backendNodeId, frameId } = refData;
    const sessionId = frameId ? this.oopifSessions.get(frameId) : undefined;

    try {
      if (!await this.ensureCDP()) return null;

      // Scroll into view first (using center alignment to avoid sticky headers/footers)
      try {
        const { object } = await this.cdpCommand('DOM.resolveNode', { backendNodeId }, 1, sessionId);
        if (object && object.objectId) {
          await this.cdpCommand('Runtime.callFunctionOn', {
            functionDeclaration: `function() { this.scrollIntoView({ block: 'center', inline: 'center' }); }`,
            objectId: object.objectId
          }, 1, sessionId);
          // Release the JS object reference to prevent V8 heap accumulation
          this.cdpCommand('Runtime.releaseObject', { objectId: object.objectId }, 0, sessionId).catch(() => { void 0; });
          // Wait briefly for smooth scrolling to settle
          await new Promise(r => setTimeout(r, 100));
        }
      } catch { /* element might already be visible or resolving failed */ }

      // Get content quads — returns viewport coordinates
      const { quads } = await this.cdpCommand('DOM.getContentQuads', { backendNodeId }, 1, sessionId);
      if (!quads || quads.length === 0) return null;

      // First quad: [x1,y1, x2,y2, x3,y3, x4,y4]
      const q = quads[0];
      const cx = Math.round((q[0] + q[2] + q[4] + q[6]) / 4);
      const cy = Math.round((q[1] + q[3] + q[5] + q[7]) / 4);

      // Use cached label from AX snapshot — eliminates a DOM.describeNode round-trip
      const label = this.refLabels.get(ref) || ref;

      return { x: cx, y: cy, label };
    } catch (e: unknown) {
      console.warn(`[BrowserViewManager] CDP getContentQuads failed for ${ref}:`, getErrorMessage(e));
      return null;
    }
  }

  /**
   * Focus an element by ref using CDP DOM.focus.
   * Works cross-frame — CDP handles iframe context automatically.
   */
  async focusElementByCDP(ref: string): Promise<string> {
    const refData = this.refMap.get(ref);
    if (!refData) return `Error: ref ${ref} not found. Run browser_snapshot first.`;
    const { backendNodeId, frameId } = refData;
    const sessionId = frameId ? this.oopifSessions.get(frameId) : undefined;

    try {
      if (!await this.ensureCDP()) return 'Error: CDP not available';
      await this.cdpCommand('DOM.focus', { backendNodeId }, 1, sessionId);
      return `Focused [${ref}] via CDP`;
    } catch (e: unknown) {
      return `CDP focus error: ${getErrorMessage(e)}`;
    }
  }

  /**
   * Clear the value of an input element using CDP.
   * Solves the OOPIF cross-frame clearing bug: legacy JS executeJS() runs in the mainFrame,
   * which fails to clear inputs inside cross-origin iframes.
   *
   * Handles both standard inputs (.value) and contenteditable elements (.textContent).
   */
  async clearInputByCDP(ref: string): Promise<string> {
    const refData = this.refMap.get(ref);
    if (!refData) return `Error: ref ${ref} not found.`;
    const { backendNodeId, frameId } = refData;
    const sessionId = frameId ? this.oopifSessions.get(frameId) : undefined;

    try {
      if (!await this.ensureCDP()) return 'Error: CDP not available';
      // Resolve the backend node to a JS object in the correct frame context
      const { object } = await this.cdpCommand('DOM.resolveNode', { backendNodeId }, 1, sessionId);
      if (!object || !object.objectId) return 'Error: Could not resolve DOM node for clearing';

      // Execute clear logic on the specific node, inside its correct frame context.
      // `this` is automatically bound to the resolved object by callFunctionOn.
      // Must handle BOTH standard inputs (have .value) and contenteditable (have .textContent).
      const clearJS = `function() {
        if ('value' in this && (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA' || this.tagName === 'SELECT')) {
          this.value = '';
        } else if (this.isContentEditable) {
          this.textContent = '';
        }
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`;
      await this.cdpCommand('Runtime.callFunctionOn', {
        functionDeclaration: clearJS,
        objectId: object.objectId,
      }, 1, sessionId);

      // Release the JS object reference to prevent V8 heap accumulation
      this.cdpCommand('Runtime.releaseObject', { objectId: object.objectId }, 0, sessionId).catch(() => { void 0; });

      return `Cleared input [${ref}] via CDP`;
    } catch (e: unknown) {
      return `CDP clear error: ${getErrorMessage(e)}`;
    }
  }

  /** Check if CDP-based refs are available (i.e., a CDP snapshot was taken). */
  hasCDPRefs(): boolean {
    return this.refMap.size > 0;
  }

  /** Get the backendDOMNodeId for a ref. */
  getRefBackendNodeId(ref: string): number | undefined {
    return this.refMap.get(ref)?.backendNodeId;
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
    const refData = this.refMap.get(ref);
    if (!refData) return;
    if (!await this.ensureCDP()) return;
    const { backendNodeId, frameId } = refData;
    const sessionId = frameId ? this.oopifSessions.get(frameId) : undefined;

    try {
      await this.cdpCommand('Overlay.enable', undefined, 1, sessionId);

      await this.cdpCommand('Overlay.highlightNode', {
        highlightConfig: {
          showInfo: true,
          showStyles: false,
          showRulers: false,
          showAccessibilityInfo: false,
          contentColor:  { r: 0, g: 255, b: 204, a: 0.15 }, // cyan neon fill
          borderColor:   { r: 0, g: 255, b: 204, a: 0.9  }, // cyan neon border
          marginColor:   { r: 0, g: 255, b: 204, a: 0.05 },
        },
        backendNodeId,
      }, 1, sessionId);

      // Auto-clear after duration
      if (this.highlightTimeout) clearTimeout(this.highlightTimeout);
      this.highlightTimeout = setTimeout(() => {
        this.cdpCommand('Overlay.hideHighlight').catch(() => { void 0; });
        this.highlightTimeout = null;
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
      const quadPromises = Array.from(this.refMap.entries()).map(async ([ref, refData]) => {
        try {
          const { backendNodeId, frameId } = refData;
          const sessionId = frameId ? this.oopifSessions.get(frameId) : undefined;
          // Ensure node is resolved in CDP's DOM tree
          let timer: NodeJS.Timeout;
          const { quads } = await Promise.race([
            this.cdpCommand('DOM.getContentQuads', { backendNodeId }, 1, sessionId),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Timeout')), 2000); })
          ]).finally(() => clearTimeout(timer!));
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
      // Bug fix: Always inject overlay into the mainFrame.
      // DOM.getContentQuads returns absolute viewport coordinates. If we inject into
      // a targetFrame (OOPIF), the boxes will be offset incorrectly by the iframe's bounds.
      await this.view!.webContents.mainFrame.executeJavaScriptInIsolatedWorld(999, [{ code: `
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

          // Inject styles into shadow DOM — Cyberpunk Targeting Aesthetic
          const style = document.createElement('style');
          style.textContent = \`
            :host { all: initial; }
            @keyframes target-lock {
              0% { transform: scale(1.1); opacity: 0; box-shadow: inset 0 0 0px rgba(0, 255, 204, 0); }
              100% { transform: scale(1); opacity: 1; box-shadow: inset 0 0 15px rgba(0, 255, 204, 0.15); }
            }
            .dsme-box {
              position: fixed;
              border: 1px solid rgba(0, 255, 204, 0.3);
              background: rgba(0, 255, 204, 0.03);
              pointer-events: none;
              box-sizing: border-box;
              opacity: 0; /* Start hidden for animation */
              animation: target-lock 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            }
            /* Sci-fi corner brackets */
            .dsme-box::before, .dsme-box::after {
              content: ''; position: absolute; width: 8px; height: 8px; pointer-events: none;
            }
            .dsme-box::before {
              top: -1px; left: -1px;
              border-top: 2px solid #00ffcc; border-left: 2px solid #00ffcc;
            }
            .dsme-box::after {
              bottom: -1px; right: -1px;
              border-bottom: 2px solid #00ffcc; border-right: 2px solid #00ffcc;
            }
            .dsme-box-inner {
              position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none;
            }
            .dsme-box-inner::before, .dsme-box-inner::after {
              content: ''; position: absolute; width: 8px; height: 8px; pointer-events: none;
            }
            .dsme-box-inner::before {
              top: -1px; right: -1px;
              border-top: 2px solid #00ffcc; border-right: 2px solid #00ffcc;
            }
            .dsme-box-inner::after {
              bottom: -1px; left: -1px;
              border-bottom: 2px solid #00ffcc; border-left: 2px solid #00ffcc;
            }
            .dsme-label {
              position: absolute;
              top: -1px;
              left: -1px;
              background: rgba(0, 255, 204, 0.9);
              color: #05080c;
              font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
              font-weight: 800;
              font-size: 10px;
              line-height: 1;
              padding: 2px 5px;
              letter-spacing: 0.5px;
              box-shadow: 0 2px 8px rgba(0, 255, 204, 0.4);
              white-space: nowrap;
              pointer-events: none;
              backdrop-filter: blur(4px);
              z-index: 2;
            }
          \`;
          shadow.appendChild(style);

          // Render boxes with staggered animation
          const boxes = ${boxesJSON};
          for (let i = 0; i < boxes.length; i++) {
            const b = boxes[i];
            const div = document.createElement('div');
            div.className = 'dsme-box';
            div.style.left = b.x + 'px';
            div.style.top = b.y + 'px';
            div.style.width = Math.max(b.w, 10) + 'px';
            div.style.height = Math.max(b.h, 10) + 'px';
            // Stagger animation based on element index
            div.style.animationDelay = (i * 0.005) + 's';

            const inner = document.createElement('div');
            inner.className = 'dsme-box-inner';
            div.appendChild(inner);

            const lbl = document.createElement('span');
            lbl.className = 'dsme-label';
            lbl.textContent = b.ref;
            div.appendChild(lbl);

            shadow.appendChild(div);
          }
        })()
      `}]);

      return `X-ray: ${boxes.length} of ${this.refMap.size} refs highlighted with [eN] labels. Run browser_clear_overlay() to dismiss.`;
    } catch (e: unknown) {
      return `Overlay error: ${getErrorMessage(e)}`;
    }
  }

  /**
   * Clear all visual overlays.
   * Handles both:
   *   - CDP single-node overlay (from highlightRef)
   *   - Shadow DOM multi-node overlay (from highlightAllRefs)
   */
  async clearOverlay(): Promise<void> {
    // Guard: view may be null during recreateView, or destroyed after crash
    if (!this.view || this.view.webContents.isDestroyed()) return;

    // Clear CDP overlay
    if (this.cdpAttached) {
      try {
        await this.cdpCommand('Overlay.hideHighlight');
        await this.cdpCommand('Overlay.disable');
      } catch { void 0; }
    }

    // Clear Shadow DOM overlay
    try {
      // Must use mainFrame + isolatedWorld 999 since highlightAllRefs creates in isolatedWorld 999.
      // Using main world here would fail if the site hooks document.getElementById.
      await this.view.webContents.mainFrame.executeJavaScriptInIsolatedWorld(999, [{ code: `
        (function() {
          const el = document.getElementById('dsme-overlay-root');
          if (el) el.remove();
        })()
      ` }]);
    } catch { void 0; }
  }

  // ── Internal ──

  private async installUserscriptFromUrl(url: string) {
    try {
      const response = await fetch(url);
      const code = await response.text();
      
      let name = 'Unknown Script';
      let match = '*://*/*';
      
      const nameMatch = code.match(/@name\s+(.+)/);
      if (nameMatch) name = nameMatch[1].trim();
      
      const matchMatches = [...code.matchAll(/@(match|include)\s+(.+)/g)];
      if (matchMatches.length > 0) {
        match = matchMatches.map(m => m[2].trim()).join(', ');
      }
      
      const { response: btnIdx } = await dialog.showMessageBox(this.mainWindow!, {
        type: 'question',
        buttons: ['Cancel', 'Install'],
        defaultId: 1,
        title: 'Install Userscript',
        message: `Do you want to install this Userscript?\n\nName: ${name}\nMatches: ${match}`
      });
      
      if (btnIdx === 1) {
        const configPath = path.join(app.getPath('userData'), 'dsme-config.json');
        
        const config = JSON.parse(await fsPromises.readFile(configPath, 'utf8')) as { userscripts?: JsonObject[] };
        const newScript = {
          id: 'script_' + Date.now(),
          name,
          match,
          enabled: true,
          code
        };
        
        if (!config.userscripts) config.userscripts = [];
        config.userscripts.push(newScript);
        
        await fsPromises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
        
        dialog.showMessageBox(this.mainWindow!, {
          type: 'info',
          title: 'Success',
          message: `Userscript "${name}" has been installed successfully!\nPlease open the Userscript Manager to view or edit it. Note: You may need to reload the page for the script to take effect.`
        });
      }
    } catch (e) {
      console.error('[BrowserViewManager] Failed to install userscript:', e);
    }
  }

  private notifyRenderer(channel: string, data: JsonObject) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}

/** Singleton — imported by browser-use.ts, browser.ts, main.ts */
export const browserViewManager = new BrowserViewManager();
