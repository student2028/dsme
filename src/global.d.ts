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

interface AppConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

declare global {
  interface Window {
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
    };
  }
}

export {};
