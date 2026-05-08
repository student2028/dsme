interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  gitStatus?: 'modified' | 'untracked' | 'clean';
}

declare global {
  interface Window {
    electronAPI: {
      sendChatMessage: (message: string) => void;
      onChatReply: (callback: (reply: string) => void) => void;
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
      onFileChanged: (callback: (filepath: string) => void) => void;
      getConfig: () => Promise<any>;
      saveConfig: (config: any) => Promise<any>;
    };
  }
}

export {};
