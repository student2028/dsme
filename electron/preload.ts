import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Chat
  sendChatMessage: (message: string) => ipcRenderer.send('chat-message', message),
  onChatReply: (callback: (reply: string) => void) => {
    ipcRenderer.on('chat-reply', (_event, value) => callback(value));
  },

  // File System
  getFileTree: (dir?: string) => ipcRenderer.invoke('get-file-tree', dir),
  openWorkspace: () => ipcRenderer.invoke('open-workspace'),
  readFile: (filepath: string) => ipcRenderer.invoke('read-file', filepath),
  writeFile: (filepath: string, content: string) => ipcRenderer.invoke('write-file', filepath, content),
  searchFiles: (query: string) => ipcRenderer.invoke('search-files', query),

  // Git
  getGitBranch: () => ipcRenderer.invoke('get-git-branch'),

  // Terminal
  onTerminalOutput: (callback: (data: string) => void) => {
    ipcRenderer.on('terminal-output', (_event, data) => callback(data));
  },
  sendTerminalInput: (data: string) => ipcRenderer.send('terminal-input', data),

  // File watcher
  onFileChanged: (callback: (filepath: string) => void) => {
    ipcRenderer.on('file-changed', (_event, filepath) => callback(filepath));
  },

  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: any) => ipcRenderer.invoke('save-config', config),
});
