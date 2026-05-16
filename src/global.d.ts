interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  gitStatus?: 'modified' | 'untracked' | 'clean';
}

interface DiffChange {
  id: string;
  filepath: string;
  filename: string;
  oldContent: string;
  newContent: string;
}

interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
}

interface AppConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
  maxContextTokens: number;
  providers: ProviderConfig[];
  activeProvider: string;
}

type Unsubscribe = () => void;

declare global {
  interface Window {
    __DSME_READY?: boolean;
    electronAPI: {
      sendChatMessage: (message: string) => void;
      onChatStreamStart: (callback: () => void) => Unsubscribe;
      onChatStreamToken: (callback: (token: string) => void) => Unsubscribe;
      onChatStreamEnd: (callback: () => void) => Unsubscribe;
      onChatStatus: (callback: (status: string) => void) => Unsubscribe;
      getFileTree: (dir?: string) => Promise<FileNode[]>;
      openWorkspace: () => Promise<string | null>;
      readFile: (filepath: string) => Promise<string>;
      writeFile: (filepath: string, content: string) => Promise<boolean>;
      searchFiles: (query: string) => Promise<{ name: string; path: string }[]>;
      searchCodebase: (query: string) => Promise<string>;
      getGitBranch: () => Promise<string>;
      getGitStatus: () => Promise<{ status: string; path: string; staged: boolean }[]>;
      gitCommit: (msg: string) => Promise<string>;
      onTerminalOutput: (callback: (data: string) => void) => Unsubscribe;
      sendTerminalInput: (data: string) => void;
      updateTitle: (title: string) => void;
      onMenuAction: (callback: (action: string) => void) => Unsubscribe;
      onFileChanged: (callback: (filepath: string) => void) => Unsubscribe;
      onDiffPreview: (callback: (change: DiffChange) => void) => Unsubscribe;
      acceptDiff: (changeId: string) => void;
      rejectDiff: (changeId: string) => void;
      getConfig: () => Promise<AppConfig>;
      saveConfig: (config: Partial<AppConfig>) => Promise<AppConfig>;
      relaunchApp: () => void;
      sendChatMessageWithImages: (message: string, imageDataUrls: string[]) => void;
      saveConversations: (data: string) => Promise<boolean>;
      loadConversations: () => Promise<string | null>;
      cancelChatRequest: () => void;
      resetConversation: () => void;
      onRagStatus: (callback: (count: number) => void) => Unsubscribe;
      onKernelChanged: (callback: (kernel: string) => void) => Unsubscribe;
      switchKernel: (kernel: string) => void;
      /** @deprecated No longer used — web_search uses BrowserViewManager directly */
      onWebSearchExecute: (callback: (data: any) => void) => Unsubscribe;
      /** @deprecated No longer used */
      sendWebSearchResults: (results: string) => void;
      /** @deprecated No longer used — browser-use tools use BrowserViewManager directly */
      onBrowserCommand: (callback: (cmd: any) => void) => Unsubscribe;
      /** @deprecated No longer used */
      sendBrowserResult: (id: string, result: string) => void;
      // WebContentsView browser panel
      syncBrowserBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
      showBrowserView: (bounds?: { x: number; y: number; width: number; height: number }) => void;
      hideBrowserView: () => void;
      onBrowserViewNavigated: (callback: (data: { url: string; title: string }) => void) => Unsubscribe;
      onBrowserStep: (callback: (data: any) => void) => Unsubscribe;
      onBrowserPanelOpen: (callback: () => void) => Unsubscribe;
    };
  }
}

export {};
