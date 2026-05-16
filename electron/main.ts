import { app, BrowserWindow, ipcMain, dialog, Menu, session } from 'electron'
import { syncChromeCookies } from './agents/chrome-cookies'
import { join } from 'node:path'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { VercelAgent } from './agents/vercel'
import { BuiltinAgent } from './agents/builtin'
import type { IAgent } from './agents/base'
import { browserViewManager } from './browser-view-manager'
import { DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, getTokenLimitsFromEnv } from './agents/token-config'
import * as os from 'node:os'
import * as cp from 'node:child_process'
import { promisify } from 'node:util'

import * as net from 'node:net';

const execAsync = promisify(cp.exec);

// Prevent EPIPE crashes when stdout pipe breaks (remote terminal disconnects)
process.stdout.on('error', (e: any) => { if (e.code !== 'EPIPE') throw e; });
process.stderr.on('error', (e: any) => { if (e.code !== 'EPIPE') throw e; });

// Global safety net — log and survive unexpected errors instead of silent crash
process.on('uncaughtException', (err) => {
  console.error('[DSME] Uncaught exception:', err.message, err.stack);
  try { win?.webContents.send('fatal-error', err.message); } catch {}
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
cdpProxy.listen(CDP_EXTERNAL, '0.0.0.0', () => console.log(`[CDP] 0.0.0.0:${CDP_EXTERNAL} ready`));
cdpProxy.on('error', (e: any) => { console.error('[CDP] Proxy error:', e?.message || e); });

let win: BrowserWindow | null
let agent: IAgent | null = null
let ptyProcess: cp.ChildProcessWithoutNullStreams | null = null
let currentKernel: 'vercel' | 'builtin' = 'vercel' // Pluggable engine selector
// Default workspace: open DSME's own project directory
let currentWorkspacePath = path.resolve(__dirname, '..')

// Config
const CONFIG_PATH = join(app.getPath('userData'), 'dsme-config.json');

interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
}

interface AppConfig {
  apiKey: string;       // Backward compat — resolved from active provider
  model: string;        // Active model
  baseUrl: string;      // Resolved from active provider
  maxOutputTokens: number;
  maxContextTokens: number;
  providers: ProviderConfig[];
  activeProvider: string;
}

/** Volcengine Ark Coding API — OpenAI-compatible; configured via VOLCENGINE_* env vars. */
const VOLCENGINE_PROVIDER_NAME = 'Volcengine';

/** Previous built-in Volcengine list — refresh saved config once when we detect this exact set. */
const VOLCENGINE_MODELS_LEGACY_FALLBACK = [
  'doubao-seed-code',
  'kimi-k2.5',
  'glm-4.7',
  'deepseek-v3.2',
  'minimax-m2.5',
  'Doubao-Seed-2.0-pro',
] as const;

function volcengineModelsNeedRefresh(savedModels: string[]): boolean {
  if (savedModels.length !== VOLCENGINE_MODELS_LEGACY_FALLBACK.length) return false;
  const a = [...savedModels].sort().join('\0');
  const b = [...VOLCENGINE_MODELS_LEGACY_FALLBACK].sort().join('\0');
  return a === b;
}

/** Ensure these Ark IDs appear in Settings even if an older saved config omitted them. */
const VOLCENGINE_ALWAYS_ENSURE_MODEL_IDS = ['MiniMax-M2.7', 'Kimi-K2.6'] as const;

/** Matches Volcengine Ark «Coding» endpoint model IDs (console order). Override with VOLCENGINE_MODELS. */
const VOLCENGINE_MODELS_FALLBACK = [
  'Doubao-Seed-2.0-Code',
  'Doubao-Seed-2.0-pro',
  'Doubao-Seed-2.0-lite',
  'Doubao-Seed-Code',
  'GLM-5.1',
  'MiniMax-M2.7',
  'Kimi-K2.6',
] as const;

function parseCommaSeparatedModels(raw: string | undefined, fallback: readonly string[]): string[] {
  if (!raw?.trim()) return [...fallback];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function buildVolcengineProvider(): ProviderConfig {
  const models = parseCommaSeparatedModels(process.env.VOLCENGINE_MODELS, VOLCENGINE_MODELS_FALLBACK);
  const envDefault = process.env.VOLCENGINE_DEFAULT_MODEL?.trim();
  /** Default when env unset: GLM-5.1 is commonly pre-enabled on new Ark projects. */
  const defaultModel = envDefault || 'GLM-5.1';
  const ordered = models.includes(defaultModel) ? models : [defaultModel, ...models];
  return {
    name: VOLCENGINE_PROVIDER_NAME,
    apiKey: process.env.VOLCENGINE_API_KEY || '',
    baseUrl: process.env.VOLCENGINE_API_BASE?.trim() || 'https://ark.cn-beijing.volces.com/api/coding/v3',
    models: ordered,
  };
}

const SILICONFLOW_PROVIDER: ProviderConfig = {
  name: 'SiliconFlow',
  apiKey: process.env.DSME_API_KEY || '',
  baseUrl: 'https://api.siliconflow.cn/v1',
  models: [
    'deepseek-ai/DeepSeek-V4-Flash',
    'deepseek-ai/DeepSeek-V3.2',
    'Pro/zai-org/GLM-5',
    'Pro/MiniMaxAI/MiniMax-M2.5',
    'Pro/moonshotai/Kimi-K2.5',
    'Qwen/Qwen3-8B',
  ],
};

const GOOGLE_PROVIDER: ProviderConfig = {
  name: 'Google',
  apiKey: process.env.GOOGLE_API_KEY || '',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  models: [
    'gemma-4-31b-it',
    'gemma-4-26b-a4b-it',
    'gemini-2.5-flash',
  ],
};

/** Volcengine first — default provider for new installs (see loadConfig catch block). */
const DEFAULT_PROVIDERS: ProviderConfig[] = [
  buildVolcengineProvider(),
  SILICONFLOW_PROVIDER,
  GOOGLE_PROVIDER,
];

function resolveActiveConfig(full: AppConfig): AppConfig {
  const provider = full.providers.find(p => p.name === full.activeProvider) || full.providers[0];
  const tokenLimits = getTokenLimitsFromEnv(process.env, {
    maxOutputTokens: full.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
    maxContextTokens: full.maxContextTokens || DEFAULT_MAX_CONTEXT_TOKENS,
  });
  return {
    ...full,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    model: full.model || provider.models[0],
    ...tokenLimits,
  };
}

async function loadConfig(): Promise<AppConfig> {
  try {
    const parsed = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    // Migration: old config without providers array
    if (!parsed.providers) {
      const mergedSf = DEFAULT_PROVIDERS.map(p =>
        p.name === 'SiliconFlow' ? { ...p, apiKey: parsed.apiKey || p.apiKey } : { ...p },
      );
      const migrated: AppConfig = {
        apiKey: parsed.apiKey || '',
        model:
          mergedSf[0].models.includes(parsed.model) ? parsed.model : mergedSf[0].models[0],
        baseUrl: parsed.baseUrl || mergedSf[0].baseUrl,
        maxOutputTokens: parsed.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
        maxContextTokens: parsed.maxContextTokens || DEFAULT_MAX_CONTEXT_TOKENS,
        providers: mergedSf,
        activeProvider: VOLCENGINE_PROVIDER_NAME,
      };
      await fs.writeFile(CONFIG_PATH, JSON.stringify(resolveActiveConfig(migrated), null, 2), 'utf8');
      return resolveActiveConfig(migrated);
    }
    // Ensure Volcengine row exists (upgrade from older installs) without overwriting user keys
    if (!parsed.providers.some((p: ProviderConfig) => p.name === VOLCENGINE_PROVIDER_NAME)) {
      parsed.providers = [buildVolcengineProvider(), ...parsed.providers];
      await fs.writeFile(CONFIG_PATH, JSON.stringify(resolveActiveConfig(parsed), null, 2), 'utf8');
    }
    const volcIdx = parsed.providers.findIndex((p: ProviderConfig) => p.name === VOLCENGINE_PROVIDER_NAME);
    if (volcIdx >= 0) {
      let row = parsed.providers[volcIdx];
      let models = [...row.models];
      let dirty = false;

      if (volcengineModelsNeedRefresh(models)) {
        const fresh = buildVolcengineProvider();
        models = [...fresh.models];
        row = { ...row, baseUrl: fresh.baseUrl };
        dirty = true;
      }

      for (const id of VOLCENGINE_ALWAYS_ENSURE_MODEL_IDS) {
        if (!models.includes(id)) {
          models.push(id);
          dirty = true;
        }
      }

      if (dirty) {
        parsed.providers[volcIdx] = { ...row, models };
        if (!models.includes(parsed.model)) {
          parsed.model = models.includes('GLM-5.1') ? 'GLM-5.1' : models[0];
        }
        await fs.writeFile(CONFIG_PATH, JSON.stringify(resolveActiveConfig(parsed), null, 2), 'utf8');
      }
    }
    return resolveActiveConfig(parsed);
  } catch {
    const volc = buildVolcengineProvider();
    const initialModel =
      process.env.VOLCENGINE_DEFAULT_MODEL?.trim() ||
      (volc.models.includes('GLM-5.1') ? 'GLM-5.1' : volc.models[0]);
    const defaultConfig: AppConfig = {
      apiKey: volc.apiKey,
      model: volc.models.includes(initialModel) ? initialModel : volc.models[0],
      baseUrl: volc.baseUrl,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      providers: DEFAULT_PROVIDERS,
      activeProvider: VOLCENGINE_PROVIDER_NAME,
    };
    return resolveActiveConfig(defaultConfig);
  }
}

async function saveConfig(config: Partial<AppConfig>) {
  const current = await loadConfig();
  const merged = { ...current, ...config };
  // Re-resolve after merge
  const resolved = resolveActiveConfig(merged);
  await fs.writeFile(CONFIG_PATH, JSON.stringify(resolved, null, 2), 'utf8');
  return resolved;
}

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
      label: 'File',
      submenu: [
        { label: 'Open Workspace...', accelerator: 'CmdOrCtrl+O', click: () => win?.webContents.send('menu-action', 'open-workspace') },
        { label: 'Quick Open', accelerator: 'CmdOrCtrl+P', click: () => win?.webContents.send('menu-action', 'quick-open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => win?.webContents.send('menu-action', 'save') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => win?.webContents.send('menu-action', 'close-tab') },
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find in Conversation', accelerator: 'CmdOrCtrl+F', click: () => win?.webContents.send('menu-action', 'find') },
        { label: 'Find in Files', accelerator: 'CmdOrCtrl+Shift+F', click: () => win?.webContents.send('menu-action', 'search') },
        { type: 'separator' },
        { label: 'New Conversation', accelerator: 'CmdOrCtrl+N', click: () => win?.webContents.send('menu-action', 'new-conversation') },
        { label: 'Focus Chat', accelerator: 'CmdOrCtrl+L', click: () => win?.webContents.send('menu-action', 'focus-chat') },
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: () => win?.webContents.send('menu-action', 'toggle-sidebar') },
        { label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+`', click: () => win?.webContents.send('menu-action', 'toggle-terminal') },
        { type: 'separator' },
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
    icon: join(__dirname, '../assets/icon.png'),
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
  ipcMain.on('browser-view-bounds', (_: any, bounds: { x: number; y: number; width: number; height: number }) => {
    browserViewManager.setBounds(bounds);
  });
  ipcMain.on('browser-view-show', (_: any, bounds?: { x: number; y: number; width: number; height: number }) => {
    browserViewManager.show(bounds);
  });
  ipcMain.on('browser-view-hide', () => {
    browserViewManager.hide();
  });

  initAgent(); startPty();
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
    ba.setupDiffHandlers();
    agent = ba;
  } else {
    console.log('[Agent] Initializing Vercel AI SDK kernel');
    const va = new VercelAgent();
    va.init(win, agentConfig);
    va.setupDiffHandlers();
    agent = va;
  }
  // Notify renderer which kernel is active
  win.webContents.send('kernel-changed', currentKernel);
}

function startPty() {
  if (ptyProcess) { ptyProcess.kill(); ptyProcess = null; }
  const shell = os.platform() === 'win32' ? 'powershell.exe' : 'zsh';
  ptyProcess = cp.spawn(shell, [], { env: process.env, cwd: currentWorkspacePath });
  ptyProcess.stdout.on('data', (d) => win?.webContents.send('terminal-output', d.toString()));
  ptyProcess.stderr.on('data', (d) => win?.webContents.send('terminal-output', d.toString()));
  ptyProcess.on('error', (err) => console.error('[PTY] Process error:', err.message));
  ptyProcess.on('close', (code) => { console.log(`[PTY] Exited with code ${code}`); ptyProcess = null; });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  if (ptyProcess) { ptyProcess.kill(); ptyProcess = null; }
  if (agent) { agent.destroy(); agent = null; }
  browserViewManager.destroy();
  cdpProxy.close();
});
app.whenReady().then(async () => {
  // Set macOS dock icon
  if (process.platform === 'darwin' && app.dock) {
    const { nativeImage } = require('electron');
    const iconPath = join(__dirname, '../assets/icon.png');
    try { app.dock.setIcon(nativeImage.createFromPath(iconPath)); } catch {}
  }

  // Sync Chrome cookies — only if not done recently (>24h)
  const syncFlag = join(app.getPath('userData'), 'cookie-sync-ts');
  const needsSync = (() => {
    try {
      const last = parseInt(require('fs').readFileSync(syncFlag, 'utf8'), 10);
      return Date.now() - last > 24 * 3600 * 1000;
    } catch { return true; } // First run
  })();
  if (needsSync) {
    syncChromeCookies(session.defaultSession)
      .then(() => require('fs').writeFileSync(syncFlag, String(Date.now())))
      .catch(() => {});
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
ipcMain.on('terminal-input', (_, data) => { if (ptyProcess) ptyProcess.stdin.write(data); });
ipcMain.on('cancel-chat-request', () => agent?.abort());
ipcMain.on('reset-conversation', () => agent?.resetConversation());
ipcMain.on('switch-kernel', async (_, kernel: string) => {
  const k = kernel === 'builtin' ? 'builtin' : 'vercel';
  if (k === currentKernel) return;
  console.log(`[Main] Switching kernel: ${currentKernel} → ${k}`);
  currentKernel = k;
  ipcMain.removeAllListeners('diff-accept');
  ipcMain.removeAllListeners('diff-reject');
  await initAgent();
});

// Reinitialize agent when config changes (no full app restart needed)
ipcMain.on('relaunch-app', async () => {
  console.log('[Main] Reinitializing agent...');
  ipcMain.removeAllListeners('diff-accept');
  ipcMain.removeAllListeners('diff-reject');
  agent?.destroy();
  agent = null;
  await initAgent();
  win?.webContents.send('chat-stream-start', '');
  win?.webContents.send('chat-stream-token', 'Agent reinitialized. New session started.');
  win?.webContents.send('chat-stream-end', '');
  win?.webContents.send('chat-status', 'idle');
});

async function getGitBranch(dir: string) {
  try { return (await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: dir })).stdout.trim(); }
  catch { return ''; }
}

let gitStatusCache: Map<string, 'modified' | 'untracked'> = new Map();
let gitStatusCacheTime = 0;
const GIT_CACHE_TTL = 5000;

async function getGitStatus(dir: string) {
  if (Date.now() - gitStatusCacheTime < GIT_CACHE_TTL) return gitStatusCache;
  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd: dir });
    const m = new Map<string, 'modified' | 'untracked'>();
    stdout.split('\n').filter(l => l.trim()).forEach(l => {
      m.set(l.substring(3).trim(), l.substring(0, 2).includes('?') ? 'untracked' : 'modified');
    });
    gitStatusCache = m;
    gitStatusCacheTime = Date.now();
    return m;
  } catch { return new Map(); }
}

async function buildFileTree(dir: string) {
  try {
    const gitMap = dir === currentWorkspacePath ? await getGitStatus(dir) : new Map();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const ignore = ['node_modules', '.git', 'dist', 'dist-electron', '.DS_Store', '__pycache__', '.next', 'build'];
    return entries
      .filter(e => !ignore.includes(e.name))
      .map(e => ({
        name: e.name,
        path: path.join(dir, e.name),
        isDirectory: e.isDirectory(),
        gitStatus: gitMap.get(path.relative(currentWorkspacePath, path.join(dir, e.name))) || 'clean',
      }))
      .sort((a, b) => a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1);
  } catch { return []; }
}

ipcMain.handle('get-file-tree', (_, dir?: string) => {
  const target = dir || currentWorkspacePath;
  if (!isWithinWorkspace(target)) return [];
  return buildFileTree(target);
});
ipcMain.handle('get-git-branch', () => getGitBranch(currentWorkspacePath));

ipcMain.handle('get-git-status', async () => {
  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd: currentWorkspacePath });
    return stdout.split('\n').filter(l => l.trim()).map(l => ({
      status: l.substring(0, 2),
      path: l.substring(3).trim(),
      staged: l[0] !== ' ' && l[0] !== '?',
    }));
  } catch { return []; }
});

ipcMain.handle('git-commit', async (_, msg: string) => {
  try {
    // Stage all changes — use spawn for injection-proof execution
    await new Promise<void>((resolve, reject) => {
      const add = cp.spawn('git', ['add', '-A'], { cwd: currentWorkspacePath });
      add.on('close', code => code === 0 ? resolve() : reject(new Error(`git add failed (exit ${code})`)));
      add.on('error', reject);
    });
    // Commit — spawn with array args prevents shell injection
    return await new Promise<string>((resolve, reject) => {
      const proc = cp.spawn('git', ['commit', '-m', msg], { cwd: currentWorkspacePath });
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => stdout += d);
      proc.stderr.on('data', d => stderr += d);
      proc.on('close', code => code === 0 ? resolve(stdout || stderr) : reject(new Error(stderr || `exit ${code}`)));
      proc.on('error', reject);
    });
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : 'commit failed'}`;
  }
});

ipcMain.handle('open-workspace', async () => {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || r.filePaths.length === 0) return null;
  currentWorkspacePath = r.filePaths[0];
  fileCacheTime = 0;
  startPty(); await initAgent();
  return currentWorkspacePath;
});

function isWithinWorkspace(fp: string): boolean {
  try {
    const resolved = path.resolve(fp);
    const ws = path.resolve(currentWorkspacePath) + path.sep;
    return resolved.startsWith(ws) || resolved === path.resolve(currentWorkspacePath);
  } catch { return false; }
}

ipcMain.handle('read-file', (_, fp) => {
  if (!isWithinWorkspace(fp)) throw new Error('Access denied: path outside workspace');
  return fs.readFile(fp, 'utf8');
});
ipcMain.handle('write-file', async (_, fp, content) => {
  if (!isWithinWorkspace(fp)) throw new Error('Access denied: path outside workspace');
  try { await fs.writeFile(fp, content, 'utf8'); return true; }
  catch { return false; }
});

// File search
let fileCache: { name: string; path: string }[] = [];
let fileCacheTime = 0;

async function walkDir(dir: string, maxDepth = 5, depth = 0): Promise<{ name: string; path: string }[]> {
  if (depth > maxDepth) return [];
  const ignore = ['node_modules', '.git', 'dist', 'dist-electron', '.DS_Store', '__pycache__'];
  const results: { name: string; path: string }[] = [];
  try {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (ignore.includes(e.name)) continue;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) results.push(...await walkDir(fp, maxDepth, depth + 1));
      else results.push({ name: e.name, path: fp });
    }
  } catch {}
  return results;
}

ipcMain.handle('search-files', async (_, query: string) => {
  if (Date.now() - fileCacheTime > 10000) { fileCache = await walkDir(currentWorkspacePath); fileCacheTime = Date.now(); }
  const q = query.toLowerCase();
  return fileCache.filter(f => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)).slice(0, 20);
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

ipcMain.handle('search-codebase', async (_, query: string) => {
  // Use spawn with array args — injection-proof, no shell escaping needed
  return new Promise<string>((resolve) => {
    const proc = cp.spawn('grep', [
      '-rn',
      '--exclude-dir=node_modules', '--exclude-dir=.git',
      '--exclude-dir=dist', '--exclude-dir=dist-electron',
      '--', query, '.'
    ], { cwd: currentWorkspacePath });
    let stdout = '';
    proc.stdout.on('data', d => {
      stdout += d;
      if (stdout.length > 2 * 1024 * 1024) proc.kill(); // Prevent memory bomb
    });
    proc.stderr.on('data', () => {}); // Ignore stderr
    proc.on('close', () => resolve(stdout));
    proc.on('error', () => resolve(''));
  });
});
