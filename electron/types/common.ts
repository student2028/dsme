/** Shared loose JSON shapes for IPC, CDP, and LLM message parts. */
export type JsonObject = Record<string, unknown>;

export interface HistoryAttachment {
  type: string;
  dataUrl?: string;
  name?: string;
  path?: string;
  content?: string;
}

export interface HistoryMessage {
  role: string;
  content: string;
  attachments?: HistoryAttachment[];
}

export interface ToolCallPayload {
  name: string;
  args: JsonObject;
}

export type IpcListener = (...args: unknown[]) => void;

/** Minimal BrowserViewManager surface used by shared-tools and agents. */
export interface BrowserViewManagerLike {
  navigate(url: string): Promise<string>;
  executeJS(script: string, timeoutMs?: number, isolated?: boolean): Promise<string>;
}

/** Browser panel step event pushed from main process to renderer. */
export interface BrowserStepEvent {
  command: string;
  sessionTitle?: string;
  params?: JsonObject;
  result?: string;
  status?: 'running' | 'done' | 'error';
  screenshotUrl?: string;
  timestamp?: number;
}

/** Vercel AI SDK stream part shapes (subset used by stream-output). */
export interface StreamToolPart {
  type?: string;
  toolName?: string;
  result?: unknown;
  output?: unknown;
  content?: unknown;
  errorText?: unknown;
  error?: unknown;
}

/** Chrome cookie row from sqlite3 -json output. */
export interface ChromeCookieRow {
  host_key: string;
  name: string;
  path: string;
  is_secure: number;
  expires_utc: number;
  is_httponly: number;
  samesite: number;
  hex_value?: string;
}
