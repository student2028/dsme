import { contextBridge, ipcRenderer } from 'electron';

try {
  if (typeof document !== 'undefined' && process.platform === 'darwin') {
    document.documentElement.classList.add('platform-darwin');
  }
} catch {
  /* ignore */
}

function createMultiSubscriberChannel(channel: string) {
  const subs = new Set<(...args: any[]) => void>();
  let listening = false;
  return (callback: (...args: any[]) => void) => {
    subs.add(callback);
    if (!listening) {
      listening = true;
      ipcRenderer.on(channel, (_e, ...args) => subs.forEach(cb => cb(...args)));
    }
    return () => { subs.delete(callback); };
  };
}

function createSingleListenerChannel(channel: string) {
  return (callback: (...args: any[]) => void) => {
    const handler = (_e: any, ...args: any[]) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.removeListener(channel, handler); };
  };
}

/** One live handler per channel; new subscribe clears previous (fixes stacked chat-stream under Strict Mode / HMR). */
function createExclusiveListenerChannel(channel: string) {
  return (callback: (...args: any[]) => void) => {
    ipcRenderer.removeAllListeners(channel);
    const handler = (_e: any, ...args: any[]) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.removeListener(channel, handler); };
  };
}

contextBridge.exposeInMainWorld('electronAPI', {
  sendChatMessage: (message: string) => ipcRenderer.send('chat-message', message),
  sendChatMessageWithImages: (message: string, imageDataUrls: string[]) => ipcRenderer.send('chat-message-images', message, imageDataUrls),
  onChatStreamStart: createExclusiveListenerChannel('chat-stream-start'),
  onChatStreamToken: createExclusiveListenerChannel('chat-stream-token'),
  onChatStreamEnd: createExclusiveListenerChannel('chat-stream-end'),
  onChatStatus: createMultiSubscriberChannel('chat-status'),

  getFileTree: (dir?: string) => ipcRenderer.invoke('get-file-tree', dir),
  openWorkspace: () => ipcRenderer.invoke('open-workspace'),
  readFile: (filepath: string) => ipcRenderer.invoke('read-file', filepath),
  writeFile: (filepath: string, content: string) => ipcRenderer.invoke('write-file', filepath, content),
  searchFiles: (query: string) => ipcRenderer.invoke('search-files', query),
  searchCodebase: (query: string) => ipcRenderer.invoke('search-codebase', query),

  getGitBranch: () => ipcRenderer.invoke('get-git-branch'),
  getGitStatus: () => ipcRenderer.invoke('get-git-status'),
  gitCommit: (msg: string) => ipcRenderer.invoke('git-commit', msg),

  onTerminalOutput: createSingleListenerChannel('terminal-output'),
  sendTerminalInput: (data: string) => ipcRenderer.send('terminal-input', data),
  updateTitle: (title: string) => ipcRenderer.send('update-title', title),
  onMenuAction: createSingleListenerChannel('menu-action'),

  onFileChanged: createMultiSubscriberChannel('file-changed'),
  onDiffPreview: createSingleListenerChannel('diff-preview'),
  acceptDiff: (changeId: string) => ipcRenderer.send('diff-accept', changeId),
  rejectDiff: (changeId: string) => ipcRenderer.send('diff-reject', changeId),

  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: any) => ipcRenderer.invoke('save-config', config),
  relaunchApp: () => ipcRenderer.send('relaunch-app'),
  cancelChatRequest: () => ipcRenderer.send('cancel-chat-request'),
  resetConversation: () => ipcRenderer.send('reset-conversation'),
  saveConversations: (data: string) => ipcRenderer.invoke('save-conversations', data),
  loadConversations: () => ipcRenderer.invoke('load-conversations'),

  onRagStatus: createSingleListenerChannel('rag-status'),

  switchKernel: (kernel: string) => ipcRenderer.send('switch-kernel', kernel),
  onKernelChanged: createExclusiveListenerChannel('kernel-changed'),

  onWebSearchExecute: createExclusiveListenerChannel('web-search-execute'),
  sendWebSearchResults: (results: string) => {
    ipcRenderer.send('web-search-results', results);
  },

  onBrowserCommand: createExclusiveListenerChannel('browser-command'),
  sendBrowserResult: (id: string, result: string) => {
    ipcRenderer.send(`browser-result-${id}`, result);
  },

  // WebContentsView-based browser panel
  syncBrowserBounds: (bounds: { x: number; y: number; width: number; height: number }) => {
    ipcRenderer.send('browser-view-bounds', bounds);
  },
  showBrowserView: (bounds?: { x: number; y: number; width: number; height: number }) => {
    ipcRenderer.send('browser-view-show', bounds);
  },
  hideBrowserView: () => {
    ipcRenderer.send('browser-view-hide');
  },
  onBrowserViewNavigated: createMultiSubscriberChannel('browser-view-navigated'),
  onBrowserStep: createMultiSubscriberChannel('browser-step'),
  onBrowserPanelOpen: createMultiSubscriberChannel('browser-panel-open'),
});
