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

declare global {
  interface Window {
    /** Set when `<App />` has mounted — CDP smoke uses this before probing DOM. */
    __DSME_READY?: boolean;
    electronAPI: {
      sendChatMessage: (message: string) => void;
      onChatStreamStart: (callback: () => void) => void;
      onChatStreamToken: (callback: (token: string) => void) => void;
      onChatStreamEnd: (callback: () => void) => void;
      onChatStatus: (callback: (status: string) => void) => void;
      getFileTree: (dir?: string) => Promise<FileNode[]>;
      openWorkspace: () => Promise<string | null>;
      readFile: (filepath: string) => Promise<string>;
      writeFile: (filepath: string, content: string) => Promise<boolean>;
      searchFiles: (query: string) => Promise<{ name: string; path: string }[]>;
      searchCodebase: (query: string) => Promise<string>;
      getGitBranch: () => Promise<string>;
      getGitStatus: () => Promise<{ status: string; path: string; staged: boolean }[]>;
      gitCommit: (msg: string) => Promise<string>;
      onTerminalOutput: (callback: (data: string) => void) => void;
      sendTerminalInput: (data: string) => void;
      updateTitle: (title: string) => void;
      onMenuAction: (callback: (action: string) => void) => void;
      onFileChanged: (callback: (filepath: string) => void) => void;
      onDiffPreview: (callback: (change: DiffChange) => void) => void;
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
      onRagStatus: (callback: (count: number) => void) => void;
      onKernelChanged: (callback: (kernel: string) => void) => void;
      switchKernel: (kernel: string) => void;
      // Web search — webview delegation
      onWebSearchExecute?: (callback: (data: {
        query: string;
        stopOnFirstResult?: boolean;
        engines: { label: string; url: string; extractJS: string }[];
      }) => void) => void;
      sendWebSearchResults?: (results: string) => void;
      // Browser-use — command execution
      onBrowserCommand?: (callback: (cmd: {
        id: string;
        command: string;
        sessionTitle?: string;
        [key: string]: unknown;
      }) => void) => void;
      sendBrowserResult?: (id: string, result: string) => void;
    };
  }
}

export {};
