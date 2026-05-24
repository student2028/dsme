import { getErrorMessage } from './lib/errors';
import { app, BrowserWindow, ipcMain, Menu, session, nativeImage, type IpcMainEvent } from 'electron'
import { syncChromeCookies, getChromeProfiles } from './agents/chrome-cookies'
import { join } from 'node:path'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import { VercelAgent } from './agents/vercel'
import { BuiltinAgent } from './agents/builtin'
import type { IAgent } from './agents/base'
import { browserViewManager } from './browser-view-manager'
import { loadConfig, saveConfig } from './config/store';
import * as net from 'node:net';

function isNodeErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return typeof e === 'object' && e !== null && 'code' in e;
}

// Prevent EPIPE crashes when stdout pipe breaks (remote terminal disconnects)
process.stdout.on('error', (e: unknown) => { if (!isNodeErrnoException(e) || e.code !== 'EPIPE') throw e; });
process.stderr.on('error', (e: unknown) => { if (!isNodeErrnoException(e) || e.code !== 'EPIPE') throw e; });

// Global safety net — log and survive unexpected errors instead of silent crash
process.on('uncaughtException', (err) => {
  console.error('[DSME] Uncaught exception:', err.message, err.stack);
  try { win?.webContents.send('fatal-error', getErrorMessage(err)); } catch { void 0; }
});
process.on('unhandledRejection', (reason) => {
  console.error('[DSME] Unhandled rejection:', reason);
});

// Ensure consistent userData path regardless of launch method (npx electron vs packaged)
app.name = 'dsme';

// Electron CDP — using temp ports until zombie cleared
const CDP_INTERNAL = 19224;
const CDP_EXTERNAL = 9418;

app.commandLine.appendSwitch('remote-debugging-port', `${CDP_INTERNAL}`);

// CDP proxy — temp ports until zombie cleared
const cdpProxy = net.createServer((src) => {
  const dst = net.createConnection(CDP_INTERNAL, '127.0.0.1');
  src.pipe(dst); dst.pipe(src);
  src.on('error', () => dst.destroy());
  dst.on('error', () => src.destroy());
});
cdpProxy.listen(CDP_EXTERNAL, '127.0.0.1', () => console.log(`[CDP] 127.0.0.1:${CDP_EXTERNAL} ready`));
cdpProxy.on('error', (e: unknown) => { console.error('[CDP] Proxy error:', getErrorMessage(e)); });

let win: BrowserWindow | null
let agent: IAgent | null = null
let currentKernel: 'vercel' | 'builtin' = 'vercel' // Pluggable engine selector
// Default workspace: open DSME's own project directory
const currentWorkspacePath = path.resolve(__dirname, '..')


// Native macOS Menu
function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'DSME',
      submenu: [
        { label: 'About DSME', role: 'about' },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => win?.webContents.send('menu-action', 'settings') },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Conversation', accelerator: 'CmdOrCtrl+F', click: () => win?.webContents.send('menu-action', 'find') },
        { type: 'separator' },
        { label: 'New Conversation', accelerator: 'CmdOrCtrl+N', click: () => win?.webContents.send('menu-action', 'new-conversation') },
        { label: 'Focus Chat', accelerator: 'CmdOrCtrl+L', click: () => win?.webContents.send('menu-action', 'focus-chat') },
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+?', click: () => win?.webContents.send('menu-action', 'shortcuts') },
      ]
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Window state persistence
const WIN_STATE_PATH = join(app.getPath('userData'), 'window-state.json');

interface WindowState { x?: number; y?: number; width: number; height: number; maximized?: boolean; }

async function loadWindowState(): Promise<WindowState> {
  try { return JSON.parse(await fs.readFile(WIN_STATE_PATH, 'utf8')); }
  catch { return { width: 1500, height: 950 }; }
}

function saveWindowState(state: WindowState) {
  fs.writeFile(WIN_STATE_PATH, JSON.stringify(state), 'utf8').catch(() => {});
}

// Window
async function createWindow() {
  const state = await loadWindowState();
  win = new BrowserWindow({
    ...state.x !== undefined && { x: state.x, y: state.y },
    width: state.width, height: state.height,
    minWidth: 900, minHeight: 600,
    titleBarStyle: 'hiddenInset', backgroundColor: '#000000',
    title: 'DSME — DeepSeek Matrix Engine',
    // icon parameter removed to prevent macOS proxy icon generation on right-click
    // which triggers the rust_bmp SIGSEGV crash when WebContentsView is attached.
    webPreferences: {
      preload: join(__dirname, '../dist-electron/preload.js'),
      nodeIntegration: false, contextIsolation: true,
    },
  });

  if (state.maximized) win.maximize();

  // Save window state on move/resize (debounced)
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const persistState = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const maximized = win.isMaximized();
      const bounds = maximized ? win.getNormalBounds() : win.getBounds();
      saveWindowState({ ...bounds, maximized });
    }, 500);
  };
  win.on('resize', persistState);
  win.on('move', persistState);
  win.on('maximize', persistState);
  win.on('unmaximize', persistState);

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'));
  }

  // Prevent default right-click context menu on the main window renderer
  // (Electron's built-in "Inspect Element" menu can crash in some configurations)
  win.webContents.on('context-menu', (event) => {
    event.preventDefault();
  });

  // Monitor renderer crashes — log details instead of silently dying
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[DSME] Renderer process gone:', details.reason, details.exitCode);
  });

  buildMenu();

  // Initialize WebContentsView-based browser panel
  browserViewManager.init(win);

  // IPC: Renderer tells us where the browser panel placeholder is
  ipcMain.on('browser-view-bounds', (_event: IpcMainEvent, bounds: { x: number; y: number; width: number; height: number }) => {
    browserViewManager.setBounds(bounds);
  });
  ipcMain.on('browser-view-show', (_event: IpcMainEvent, bounds?: { x: number; y: number; width: number; height: number }) => {
    browserViewManager.show(bounds);
  });
  ipcMain.on('browser-view-hide', () => {
    browserViewManager.hide();
  });

  initAgent();
}

async function initAgent() {
  if (!win) return;
  // Destroy previous agent cleanly
  if (agent) { agent.destroy(); agent = null; }
  const config = await loadConfig();
  const agentConfig = {
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    cwd: currentWorkspacePath,
    maxOutputTokens: config.maxOutputTokens,
    maxContextTokens: config.maxContextTokens,
  };
  console.log(`[Agent] Config: apiKey=${config.apiKey ? '***SET***' : 'EMPTY'}, model=${config.model}, baseUrl=${config.baseUrl}, maxOutputTokens=${config.maxOutputTokens}, maxContextTokens=${config.maxContextTokens}`);

  if (currentKernel === 'builtin') {
    console.log('[Agent] Initializing Built-in kernel');
    const ba = new BuiltinAgent();
    ba.init(win, agentConfig);
    agent = ba;
  } else {
    console.log('[Agent] Initializing Vercel AI SDK kernel');
    const va = new VercelAgent();
    va.init(win, agentConfig);
    agent = va;
  }
  // Notify renderer which kernel is active
  win.webContents.send('kernel-changed', currentKernel);
}



app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  if (agent) { agent.destroy(); agent = null; }
  browserViewManager.destroy();
  cdpProxy.close();
});

// Set global User-Agent fallback to mask Electron environment from Popups/IFrames
const CHROME_VERSION = '131';
const CHROME_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION}.0.0.0 Safari/537.36`;
app.userAgentFallback = CHROME_UA;

// Hide Electron and automated signs from the browser engine
app.commandLine.appendSwitch('disable-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

app.whenReady().then(async () => {
  // Set macOS dock icon
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = join(__dirname, '../assets/icon.png');
    try { app.dock.setIcon(nativeImage.createFromPath(iconPath)); } catch { void 0; }
  }

  // Sync Chrome cookies — only if not done recently (>24h)
  const syncFlag = join(app.getPath('userData'), 'cookie-sync-ts');
  const needsSync = (() => {
    try {
      const last = parseInt(fsSync.readFileSync(syncFlag, 'utf8'), 10);
      return Date.now() - last > 24 * 3600 * 1000;
    } catch { return true; }
  })();
  if (needsSync) {
    // Sync to both default session AND the browser panel session
    const browserSession = session.fromPartition('persist:browser-panel-v2');
    Promise.all([
      syncChromeCookies(session.defaultSession),
      syncChromeCookies(browserSession),
    ])
      .then(() => { fsSync.writeFileSync(syncFlag, String(Date.now())); })
      .catch(() => { void 0; });
  }

  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Dynamic window title
ipcMain.on('update-title', (_, title: string) => {
  if (win) win.setTitle(title ? `${title} — DSME` : 'DSME — DeepSeek Matrix Engine');
});

// IPC — dispatch to agent
ipcMain.on('chat-message', async (_, msg) => {
  if (!agent) return;
  agent.handleMessage(msg);
});
ipcMain.on('chat-message-images', async (_, msg, imageDataUrls) => {
  if (!agent) return;
  agent.handleMessageWithImages(msg, imageDataUrls);
});
ipcMain.on('cancel-chat-request', () => agent?.abort());
ipcMain.on('reset-conversation', () => agent?.resetConversation());
ipcMain.on('sync-history', (_, messages) => agent?.loadHistory(messages));
ipcMain.on('switch-kernel', async (_, kernel: string) => {
  const k = kernel === 'builtin' ? 'builtin' : 'vercel';
  if (k === currentKernel) return;
  console.log(`[Main] Switching kernel: ${currentKernel} → ${k}`);
  currentKernel = k;
  await initAgent();
});

// Reinitialize agent when config changes (no full app restart needed)
ipcMain.on('relaunch-app', async () => {
  console.log('[Main] Reinitializing agent...');
  agent?.destroy();
  agent = null;
  await initAgent();
  win?.webContents.send('chat-stream-start', '');
  win?.webContents.send('chat-stream-token', 'Agent reinitialized. New session started.');
  win?.webContents.send('chat-stream-end', '');
  win?.webContents.send('chat-status', 'idle');
});

// Window drag API to bypass -webkit-app-region: drag bugs
ipcMain.on('move-window-by', (e, dx, dy) => {
  const window = BrowserWindow.fromWebContents(e.sender);
  if (window && !window.isDestroyed()) {
    const [x, y] = window.getPosition();
    window.setPosition(x + dx, y + dy, false); // false = no animation
  }
});

ipcMain.handle('capture-window', async () => {
  if (!win || win.isDestroyed()) return null;
  try {
    const nativeImg = await win.capturePage();
    return nativeImg.toDataURL(); // e.g. data:image/png;base64,...
  } catch {
    return null;
  }
});

ipcMain.handle('get-chrome-profiles', () => {
  return getChromeProfiles();
});

ipcMain.handle('sync-chrome-cookies', async (_, profileDirName?: string) => {
  if (process.platform !== 'darwin') return { success: false, count: 0, error: 'Only macOS supported' };
  try {
    const profile = profileDirName || 'Default';
    const browserSession = session.fromPartition('persist:browser-panel-v2');
    const [defaultCount, browserCount] = await Promise.all([
      syncChromeCookies(session.defaultSession, profile),
      syncChromeCookies(browserSession, profile),
    ]);
    const syncFlag = join(app.getPath('userData'), 'cookie-sync-ts');
    fsSync.writeFileSync(syncFlag, String(Date.now()));
    return { success: true, count: defaultCount + browserCount, profile };
  } catch (e: unknown) {
    return { success: false, count: 0, error: getErrorMessage(e) };
  }
});

ipcMain.handle('browser-go-back', async () => {
  return browserViewManager.goBack();
});

ipcMain.handle('browser-go-forward', async () => {
  return browserViewManager.goForward();
});

ipcMain.handle('browser-navigate-to', async (_, url: string) => {
  try {
    let target = url;
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      target = 'https://' + target;
    }
    await browserViewManager.navigate(target);
    return `Navigating to ${target}`;
  } catch (e: unknown) {
    return `Failed: ${getErrorMessage(e)}`;
  }
});

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', async (_, config) => { const m = await saveConfig(config); await initAgent(); return m; });

// Chat persistence
const CHAT_DIR = join(app.getPath('userData'), 'conversations');
fs.mkdir(CHAT_DIR, { recursive: true }).catch(() => {});

ipcMain.handle('save-conversations', async (_, data: string) => {
  await fs.writeFile(join(CHAT_DIR, 'sessions.json'), data, 'utf8');
  return true;
});

ipcMain.handle('load-conversations', async () => {
  try { return await fs.readFile(join(CHAT_DIR, 'sessions.json'), 'utf8'); }
  catch { return null; }
});
