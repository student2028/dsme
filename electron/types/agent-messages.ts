/** Shared message / stream part shapes for Vercel and Builtin agent kernels. */
import type { HistoryAttachment, HistoryMessage, JsonObject } from './common';

export type { HistoryAttachment, HistoryMessage, JsonObject };

/** Text or multimodal user content for Vercel AI SDK. */
export type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: string | URL; mimeType?: string };

export type ToolCallContentPart = {
  type: 'tool-call';
  toolCallId?: string;
  toolName?: string;
  [key: string]: unknown;
};

export type ToolResultContentPart = {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  result?: unknown;
  output?: unknown;
  content?: unknown;
  [key: string]: unknown;
};

export type AgentMessage = {
  role: string;
  content: string | UserContentPart[] | ToolResultContentPart[];
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
};

export interface OpenAIToolCall {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** OpenAI chat completion message with optional tool_calls. */
export interface OpenAIChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

/** Vercel fullStream part union (subset used in runStream). */
export interface VercelStreamPart {
  type: string;
  text?: string;
  textDelta?: string;
  toolCallId?: string;
  id?: string;
  toolName?: string;
  error?: unknown;
  result?: unknown;
  output?: unknown;
  content?: unknown;
}

export interface ParsedTextToolCall {
  name: string;
  args: JsonObject;
}

/** Helper: read string field from tool args. */
export function toolArgString(args: JsonObject, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/** Helper: read number field from tool args. */
export function toolArgNumber(args: JsonObject, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}
