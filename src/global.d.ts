import type { BrowserStepEvent, HistoryMessage } from '../electron/types/common';

interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
}

export interface Userscript {
  id: string;
  name: string;
  match: string;
  code: string;
  enabled: boolean;
}

interface AppConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  maxContextTokens?: number;
  maxToolSteps?: number;
  providers: ProviderConfig[];
  activeProvider: string;
  bookmarks?: { title: string; url: string; icon?: string; folder?: string }[];
  userscripts?: Userscript[];
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
      updateTitle: (title: string) => void;
      onMenuAction: (callback: (action: string) => void) => Unsubscribe;
      getConfig: () => Promise<AppConfig>;
      saveConfig: (config: Partial<AppConfig>) => Promise<AppConfig>;
      relaunchApp: () => void;
      sendChatMessageWithImages: (message: string, imageDataUrls: string[]) => void;
      saveConversations: (data: string) => Promise<boolean>;
      loadConversations: () => Promise<string | null>;
      cancelChatRequest: () => void;
      resetConversation: () => void;
      syncHistory: (messages: HistoryMessage[]) => void;
      onKernelChanged: (callback: (kernel: string) => void) => Unsubscribe;
      switchKernel: (kernel: string) => void;
      syncBrowserBounds: (bounds: { x: number; y: number; width: number; height: number }) => void;
      showBrowserView: (bounds?: { x: number; y: number; width: number; height: number }) => void;
      hideBrowserView: () => void;
      onBrowserViewNavigated: (callback: (data: { url: string; title: string }) => void) => Unsubscribe;
      onBrowserStep: (callback: (data: BrowserStepEvent) => void) => Unsubscribe;
      onBrowserPanelOpen: (callback: () => void) => Unsubscribe;
      moveWindowBy: (dx: number, dy: number) => void;
      getChromeProfiles: () => Promise<{ dirName: string; name: string; email: string; cookiesPath: string }[]>;
      syncChromeCookies: (profileDirName?: string) => Promise<{ success: boolean; count: number; profile?: string; error?: string }>;
      browserGoBack: () => Promise<string>;
      browserGoForward: () => Promise<string>;
      browserNavigateTo: (url: string) => Promise<string>;
    };
  }
}

export {};
