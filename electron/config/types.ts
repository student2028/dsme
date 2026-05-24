export interface ProviderConfig {
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

export interface AppConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxOutputTokens: number;
  maxContextTokens: number;
  maxToolSteps?: number;
  providers: ProviderConfig[];
  activeProvider: string;
  bookmarks?: { title: string; url: string; icon?: string; folder?: string }[];
  userscripts?: Userscript[];
}
