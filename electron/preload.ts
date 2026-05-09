import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Chat
  sendChatMessage: (message: string) => ipcRenderer.send('chat-message', message),
  sendChatMessageWithImages: (message: string, imageDataUrls: string[]) => ipcRenderer.send('chat-message-images', message, imageDataUrls),
  onChatStreamStart: (callback: () => void) => {
    ipcRenderer.removeAllListeners('chat-stream-start');
    ipcRenderer.on('chat-stream-start', () => callback());
  },
  onChatStreamToken: (callback: (token: string) => void) => {
    ipcRenderer.removeAllListeners('chat-stream-token');
    ipcRenderer.on('chat-stream-token', (_e, v) => callback(v));
  },
  onChatStreamEnd: (callback: () => void) => {
    ipcRenderer.removeAllListeners('chat-stream-end');
    ipcRenderer.on('chat-stream-end', () => callback());
  },
  onChatStatus: (callback: (status: string) => void) => {
    ipcRenderer.removeAllListeners('chat-status');
    ipcRenderer.on('chat-status', (_e, v) => callback(v));
  },

  // File System
  getFileTree: (dir?: string) => ipcRenderer.invoke('get-file-tree', dir),
  openWorkspace: () => ipcRenderer.invoke('open-workspace'),
  readFile: (filepath: string) => ipcRenderer.invoke('read-file', filepath),
  writeFile: (filepath: string, content: string) => ipcRenderer.invoke('write-file', filepath, content),
  searchFiles: (query: string) => ipcRenderer.invoke('search-files', query),
  searchCodebase: (query: string) => ipcRenderer.invoke('search-codebase', query),

  // Git
  getGitBranch: () => ipcRenderer.invoke('get-git-branch'),
  getGitStatus: () => ipcRenderer.invoke('get-git-status'),
  gitCommit: (msg: string) => ipcRenderer.invoke('git-commit', msg),

  // Terminal
  onTerminalOutput: (callback: (data: string) => void) => {
    ipcRenderer.removeAllListeners('terminal-output');
    ipcRenderer.on('terminal-output', (_e, d) => callback(d));
  },
  sendTerminalInput: (data: string) => ipcRenderer.send('terminal-input', data),
  updateTitle: (title: string) => ipcRenderer.send('update-title', title),
  onMenuAction: (callback: (action: string) => void) => {
    ipcRenderer.removeAllListeners('menu-action');
    ipcRenderer.on('menu-action', (_e, action) => callback(action));
  },

  // File watcher
  onFileChanged: (callback: (filepath: string) => void) => {
    ipcRenderer.removeAllListeners('file-changed');
    ipcRenderer.on('file-changed', (_e, fp) => callback(fp));
  },
  onDiffPreview: (callback: (change: any) => void) => {
    ipcRenderer.removeAllListeners('diff-preview');
    ipcRenderer.on('diff-preview', (_e, change) => callback(change));
  },
  acceptDiff: (changeId: string) => ipcRenderer.send('diff-accept', changeId),
  rejectDiff: (changeId: string) => ipcRenderer.send('diff-reject', changeId),

  // Config
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: any) => ipcRenderer.invoke('save-config', config),
  relaunchApp: () => ipcRenderer.send('relaunch-app'),
  cancelChatRequest: () => ipcRenderer.send('cancel-chat-request'),
  resetConversation: () => ipcRenderer.send('reset-conversation'),
  saveConversations: (data: string) => ipcRenderer.invoke('save-conversations', data),
  loadConversations: () => ipcRenderer.invoke('load-conversations'),

  // RAG
  onRagStatus: (callback: (count: number) => void) => {
    ipcRenderer.removeAllListeners('rag-status');
    ipcRenderer.on('rag-status', (_e, count) => callback(count));
  },
});
