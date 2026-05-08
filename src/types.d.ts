export interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  gitStatus?: 'modified' | 'untracked' | 'clean';
}

interface Window {
  electronAPI: {
    // Chat
    sendChatMessage: (message: string) => void;
    onChatReply: (callback: (reply: string) => void) => void;

    // File System
    getFileTree: (dir?: string) => Promise<FileNode[]>;
    openWorkspace: () => Promise<string | null>;
    readFile: (filepath: string) => Promise<string>;
    writeFile: (filepath: string, content: string) => Promise<boolean>;
    searchFiles: (query: string) => Promise<{ name: string; path: string }[]>;

    // Git
    getGitBranch: () => Promise<string>;

    // Terminal
    onTerminalOutput: (callback: (data: string) => void) => void;
    sendTerminalInput: (data: string) => void;

    // File watcher
    onFileChanged: (callback: (filepath: string) => void) => void;

    // Config
    getConfig: () => Promise<{ apiKey: string; model: string; baseUrl: string; theme: string }>;
    saveConfig: (config: any) => Promise<any>;
  };
}
