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
  onChatStreamStart: createMultiSubscriberChannel('chat-stream-start'),
  onChatStreamToken: createMultiSubscriberChannel('chat-stream-token'),
  onChatStreamEnd: createMultiSubscriberChannel('chat-stream-end'),
  onChatStatus: createMultiSubscriberChannel('chat-status'),

  moveWindowBy: (dx: number, dy: number) => ipcRenderer.send('move-window-by', dx, dy),
  updateTitle: (title: string) => ipcRenderer.send('update-title', title),
  onMenuAction: createSingleListenerChannel('menu-action'),

  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: any) => ipcRenderer.invoke('save-config', config),
  relaunchApp: () => ipcRenderer.send('relaunch-app'),
  cancelChatRequest: () => ipcRenderer.send('cancel-chat-request'),
  resetConversation: () => ipcRenderer.send('reset-conversation'),
  saveConversations: (data: string) => ipcRenderer.invoke('save-conversations', data),
  loadConversations: () => ipcRenderer.invoke('load-conversations'),
  syncHistory: (messages: any[]) => ipcRenderer.send('sync-history', messages),

  switchKernel: (kernel: string) => ipcRenderer.send('switch-kernel', kernel),
  onKernelChanged: createExclusiveListenerChannel('kernel-changed'),

  // [DEPRECATED] Legacy IPC — no longer used after WebContentsView migration.
  // web_search now calls BrowserViewManager directly; browser-use tools do too.
  // Kept as no-ops to prevent runtime errors if any stale code references them.
  onWebSearchExecute: (_cb: any) => () => {},
  sendWebSearchResults: (_results: string) => {},
  onBrowserCommand: (_cb: any) => () => {},
  sendBrowserResult: (_id: string, _result: string) => {},

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
  
  captureWindow: () => ipcRenderer.invoke('capture-window'),

  getChromeProfiles: () => ipcRenderer.invoke('get-chrome-profiles'),
  syncChromeCookies: (profileDirName?: string) => ipcRenderer.invoke('sync-chrome-cookies', profileDirName),

  browserGoBack: () => ipcRenderer.invoke('browser-go-back'),
  browserGoForward: () => ipcRenderer.invoke('browser-go-forward'),
  browserNavigateTo: (url: string) => ipcRenderer.invoke('browser-navigate-to', url),
});
