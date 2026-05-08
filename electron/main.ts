import { app, BrowserWindow, ipcMain, dialog, globalShortcut } from 'electron'
import { join } from 'node:path'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { DeepSeekAgent } from './agent'
import * as os from 'node:os'
import * as cp from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(cp.exec);

process.env.DIST_ELECTRON = join(__dirname, '..')
process.env.DIST = join(process.env.DIST_ELECTRON, '../dist')
process.env.VITE_PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? join(process.env.DIST_ELECTRON, '../public')
  : process.env.DIST

let win: BrowserWindow | null
let agent: DeepSeekAgent | null = null
let ptyProcess: cp.ChildProcessWithoutNullStreams | null = null
let currentWorkspacePath = process.cwd()

// ===== CONFIG PERSISTENCE =====
const CONFIG_PATH = join(app.getPath('userData'), 'dsme-config.json');

interface AppConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  theme: string;
}

const DEFAULT_CONFIG: AppConfig = {
  apiKey: '',
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com/v1',
  theme: 'matrix',
};

async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(config: Partial<AppConfig>) {
  const existing = await loadConfig();
  const merged = { ...existing, ...config };
  await fs.writeFile(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

// ===== WINDOW =====
function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#000000',
    webPreferences: {
      preload: join(__dirname, '../dist-electron/preload.mjs'),
      nodeIntegration: true,
      contextIsolation: true,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(join(process.env.DIST, 'index.html'))
  }

  initAgent();
  startPty();
}

async function initAgent() {
  if (!win) return;
  const config = await loadConfig();
  agent = new DeepSeekAgent(win, {
    apiKey: config.apiKey || process.env.DEEPSEEK_API_KEY || '',
    model: config.model,
    baseUrl: config.baseUrl,
    cwd: currentWorkspacePath,
  });
}

function startPty() {
  if (ptyProcess) ptyProcess.kill();
  const shell = os.platform() === 'win32' ? 'powershell.exe' : 'zsh';
  ptyProcess = cp.spawn(shell, [], { env: process.env, cwd: currentWorkspacePath });

  ptyProcess.stdout.on('data', (data) => {
    win?.webContents.send('terminal-output', data.toString());
  });
  ptyProcess.stderr.on('data', (data) => {
    win?.webContents.send('terminal-output', data.toString());
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ===== IPC: CHAT =====
ipcMain.on('chat-message', async (_event, userMessage) => {
  if (agent) agent.handleUserMessage(userMessage);
});

ipcMain.on('terminal-input', (_event, data) => {
  if (ptyProcess) ptyProcess.stdin.write(data);
});

// ===== IPC: GIT =====
async function getGitBranch(dir: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: dir });
    return stdout.trim();
  } catch { return ''; }
}

async function getGitStatus(dir: string) {
  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd: dir });
    const statusMap = new Map<string, 'modified' | 'untracked'>();
    for (const line of stdout.split('\n').filter(l => l.trim())) {
      const code = line.substring(0, 2);
      const file = line.substring(3).trim();
      statusMap.set(file, code.includes('?') ? 'untracked' : 'modified');
    }
    return statusMap;
  } catch { return new Map(); }
}

// ===== IPC: FILE SYSTEM =====
async function buildFileTree(dir: string): Promise<any[]> {
  try {
    const gitStatusMap = dir === currentWorkspacePath ? await getGitStatus(dir) : new Map();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const nodes = [];
    const ignoreList = ['node_modules', '.git', 'dist', 'dist-electron', '.DS_Store', '__pycache__', '.next', 'build'];

    for (const entry of entries) {
      if (ignoreList.includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(currentWorkspacePath, fullPath);

      nodes.push({
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        gitStatus: gitStatusMap.get(relativePath) || 'clean',
      });
    }
    return nodes.sort((a, b) => {
      if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
      return a.isDirectory ? -1 : 1;
    });
  } catch { return []; }
}

ipcMain.handle('get-file-tree', async (_event, dir?: string) => {
  return buildFileTree(dir || currentWorkspacePath);
});

ipcMain.handle('get-git-branch', async () => {
  return getGitBranch(currentWorkspacePath);
});

ipcMain.handle('open-workspace', async () => {
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;

  currentWorkspacePath = result.filePaths[0];
  process.chdir(currentWorkspacePath);
  startPty();
  await initAgent();
  return currentWorkspacePath;
});

ipcMain.handle('read-file', async (_, filepath) => {
  return fs.readFile(filepath, 'utf8');
});

ipcMain.handle('write-file', async (_, filepath, content) => {
  await fs.writeFile(filepath, content, 'utf8');
  return true;
});

// ===== IPC: FILE SEARCH (for Command Palette) =====
async function walkDir(dir: string, maxDepth = 5, depth = 0): Promise<{name: string, path: string}[]> {
  if (depth > maxDepth) return [];
  const results: {name: string, path: string}[] = [];
  const ignoreList = ['node_modules', '.git', 'dist', 'dist-electron', '.DS_Store', '__pycache__', '.next', 'build'];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoreList.includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await walkDir(fullPath, maxDepth, depth + 1);
        results.push(...sub);
      } else {
        results.push({ name: entry.name, path: fullPath });
      }
    }
  } catch {}
  return results;
}

let fileCache: {name: string, path: string}[] = [];
let fileCacheTime = 0;

ipcMain.handle('search-files', async (_, query: string) => {
  // Rebuild cache every 10 seconds
  if (Date.now() - fileCacheTime > 10000) {
    fileCache = await walkDir(currentWorkspacePath);
    fileCacheTime = Date.now();
  }

  const q = query.toLowerCase();
  return fileCache
    .filter(f => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
    .slice(0, 20)
    .map(f => ({ name: f.name, path: f.path }));
});

// ===== IPC: CONFIG =====
ipcMain.handle('get-config', async () => {
  return loadConfig();
});

ipcMain.handle('save-config', async (_, config: Partial<AppConfig>) => {
  const merged = await saveConfig(config);
  // Re-init agent with new settings
  await initAgent();
  return merged;
});
