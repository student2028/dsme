import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'node:path'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { DeepSeekAgent } from './agent'
import * as os from 'node:os'
import * as cp from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(cp.exec);

let win: BrowserWindow | null
let agent: DeepSeekAgent | null = null
let ptyProcess: cp.ChildProcessWithoutNullStreams | null = null
let currentWorkspacePath = process.cwd()

// Config
const CONFIG_PATH = join(app.getPath('userData'), 'dsme-config.json');

interface AppConfig { apiKey: string; model: string; baseUrl: string; }

const DEFAULT_CONFIG: AppConfig = {
  apiKey: 'sk-lqowsnopfxvymjqaeaafrbsnncpuxubrqfemorsbqdoyrvjk',
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

// Window
function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 900, minHeight: 600,
    titleBarStyle: 'hiddenInset', backgroundColor: '#000000',
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

  initAgent(); startPty();
}

async function initAgent() {
  if (!win) return;
  const config = await loadConfig();
  agent = new DeepSeekAgent(win, {
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    cwd: currentWorkspacePath,
  });
}

function startPty() {
  if (ptyProcess) ptyProcess.kill();
  const shell = os.platform() === 'win32' ? 'powershell.exe' : 'zsh';
  ptyProcess = cp.spawn(shell, [], { env: process.env, cwd: currentWorkspacePath });
  ptyProcess.stdout.on('data', (d) => win?.webContents.send('terminal-output', d.toString()));
  ptyProcess.stderr.on('data', (d) => win?.webContents.send('terminal-output', d.toString()));
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// IPC
ipcMain.on('chat-message', async (_, msg) => { if (agent) agent.handleUserMessage(msg); });
ipcMain.on('terminal-input', (_, data) => { if (ptyProcess) ptyProcess.stdin.write(data); });

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
ipcMain.handle('write-file', async (_, fp, content) => { await fs.writeFile(fp, content, 'utf8'); return true; });

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
