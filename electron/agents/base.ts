/**
 * IAgent — Pluggable agent interface for DSME.
 *
 * All agent implementations (built-in, Vercel AI SDK, Mastra, etc.)
 * must conform to this interface. The IDE shell dispatches user messages
 * through this abstraction; the agent handles LLM calls, tool execution,
 * and streams results back via the provided callbacks.
 */

import { BrowserWindow } from 'electron';

// ── Agent configuration ─────────────────────────────────────────────
export interface AgentConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  cwd: string;
  maxOutputTokens: number;
  maxContextTokens: number;
}

// ── Callback contract (IDE ← Agent) ─────────────────────────────────
export interface AgentCallbacks {
  onStreamStart: () => void;
  onStreamToken: (token: string) => void;
  onStreamEnd: () => void;
  onReply: (text: string) => void;
  onToolCall: (toolName: string) => void;
  onStatus: (status: string) => void;
  onError: (error: string) => void;
  onTerminalOutput: (data: string) => void;
  onFileChanged: (filepath: string) => void;
  onDiffPreview: (change: { id: string; filepath: string; filename: string; oldContent: string; newContent: string }) => void;
}

// ── Agent interface ─────────────────────────────────────────────────
export interface IAgent {
  readonly name: string;

  /** Initialize the agent with config and IDE window */
  init(window: BrowserWindow, config: AgentConfig): void;

  /** Handle a plain-text user message */
  handleMessage(content: string): Promise<void>;

  /** Handle a multimodal message (text + images) */
  handleMessageWithImages(content: string, imageDataUrls: string[]): Promise<void>;

  /** Reset the conversation (new session) */
  resetConversation(): void;

  /** Load history from frontend to restore context after app restart */
  loadHistory(messages: any[]): void;

  /** Abort the current request */
  abort(): void;

  /** Clean up resources (file watchers, timers) before disposal */
  destroy(): void;

  /** Setup IPC diff handlers (accept/reject) */
  setupDiffHandlers(): void;
}

// ── Shared tool implementations ─────────────────────────────────────
// Tools are defined once and shared across all agent kernels.
// Each kernel adapts them to its own tool format (OpenAI tools, Vercel tool(), etc.)

export interface ToolResult {
  content: string;
}

export type ToolExecutor = (args: Record<string, unknown>, cwd: string, callbacks: AgentCallbacks) => Promise<string>;

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: ToolExecutor;
}
