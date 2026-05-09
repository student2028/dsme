import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import { join } from 'node:path'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { VercelAgent } from './agents/vercel'
import type { IAgent } from './agents/base'
import * as os from 'node:os'
import * as cp from 'node:child_process'
import { promisify } from 'node:util'

import * as net from 'node:net';

const execAsync = promisify(cp.exec);

// Electron CDP — using temp ports until zombie 19222 is cleared by reboot
app.commandLine.appendSwitch('remote-debugging-port', '19223');

// CDP proxy — temp ports until zombie cleared
const CDP_INTERNAL = 19223;
const CDP_EXTERNAL = 9419;
const cdpProxy = net.createServer((src) => {
  const dst = net.createConnection(CDP_INTERNAL, '127.0.0.1');
  src.pipe(dst); dst.pipe(src);
  src.on('error', () => dst.destroy());
  dst.on('error', () => src.destroy());
});
cdpProxy.listen(CDP_EXTERNAL, '0.0.0.0', () => console.log(`[CDP] 0.0.0.0:${CDP_EXTERNAL} ready`));
cdpProxy.on('error', () => {});

let win: BrowserWindow | null
let agent: IAgent | null = null
let ptyProcess: cp.ChildProcessWithoutNullStreams | null = null
// Default workspace: open DSME's own project directory
let currentWorkspacePath = path.resolve(__dirname, '..')

// Config
const CONFIG_PATH = join(app.getPath('userData'), 'dsme-config.json');

interface AppConfig { apiKey: string; model: string; baseUrl: string; }

const DEFAULT_CONFIG: AppConfig = {
  apiKey: process.env.DSME_API_KEY || '',
  model: 'deepseek-ai/DeepSeek-V4-Flash',
  baseUrl: 'https://api.siliconflow.cn/v1',
};

async function loadConfig(): Promise<AppConfig> {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')) }; }
  catch { return { ...DEFAULT_CONFIG }; }
}

async function saveConfig(config: Partial<AppConfig>) {
  const merged = { ...(await loadConfig()), ...config };
  await fs.writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
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

// Window
function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 900, minHeight: 600,
    titleBarStyle: 'hiddenInset', backgroundColor: '#000000',
    title: 'DSME — DeepSeek Matrix Engine',
    webPreferences: {
      preload: join(__dirname, '../dist-electron/preload.js'),
      nodeIntegration: true, contextIsolation: true,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'))
  }

  buildMenu();
  initAgent(); startPty();
}

async function initAgent() {
  if (!win) return;
  const config = await loadConfig();
  const agentConfig = {
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    cwd: currentWorkspacePath,
  };

  console.log('[Agent] Initializing Vercel AI SDK kernel');
  const va = new VercelAgent();
  va.init(win, agentConfig);
  va.setupDiffHandlers();
  agent = va;
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
  cdpProxy.close();
});
app.whenReady().then(() => {
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

async function getGitStatus(dir: string) {
  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd: dir });
    const m = new Map<string, 'modified' | 'untracked'>();
    stdout.split('\n').filter(l => l.trim()).forEach(l => {
      m.set(l.substring(3).trim(), l.substring(0, 2).includes('?') ? 'untracked' : 'modified');
    });
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

ipcMain.handle('get-file-tree', (_, dir?: string) => buildFileTree(dir || currentWorkspacePath));
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
    await execAsync('git add -A', { cwd: currentWorkspacePath });
    // Sanitize commit message to prevent shell injection
    const safeMsg = msg.replace(/[`$\\!]/g, '').replace(/"/g, '\\"');
    const { stdout } = await execAsync(`git commit -m "${safeMsg}"`, { cwd: currentWorkspacePath });
    return stdout;
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : 'commit failed'}`;
  }
});

ipcMain.handle('open-workspace', async () => {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || r.filePaths.length === 0) return null;
  currentWorkspacePath = r.filePaths[0];
  process.chdir(currentWorkspacePath);
  startPty(); await initAgent();
  return currentWorkspacePath;
});

ipcMain.handle('read-file', (_, fp) => fs.readFile(fp, 'utf8'));
ipcMain.handle('write-file', async (_, fp, content) => {
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
  try {
    // Sanitize query to prevent shell injection
    const safeQuery = query.replace(/[;&|`$(){}!#"'\\]/g, '\\$&');
    const cmd = `grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=dist-electron "${safeQuery}" .`;
    const { stdout } = await execAsync(cmd, { cwd: currentWorkspacePath, maxBuffer: 2 * 1024 * 1024 });
    return stdout || '';
  } catch (e) { return (e instanceof Error && 'stdout' in e) ? (e as { stdout: string }).stdout : ''; }
});
