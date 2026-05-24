/**
 * DSME Agent Kernel — Vercel AI SDK
 *
 * Uses the official Vercel AI SDK (streamText + tool) for:
 * - Streaming text generation
 * - Declarative tool definitions with Zod schemas
 * - Automatic multi-step tool call loops (stopWhen)
 * - Built-in abort, retry, and lifecycle callbacks
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BrowserWindow } from 'electron';
import { streamText, tool, stepCountIs, type ModelMessage } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import type { IAgent, AgentConfig } from './base';
import { getErrorMessage } from '../lib/errors';
import { executeRunCommand } from '../lib/run-command';
import type { HistoryAttachment, HistoryMessage, JsonObject } from '../types/common';
import type {
  ToolCallContentPart,
  UserContentPart,
  VercelStreamPart,
} from '../types/agent-messages';
import { formatToolArgs } from './tool-display';
import { parseTextToolCalls } from './text-tool-parser';
import { browserViewManager } from '../browser-view-manager';
import { browsePage } from './browser';
import { shouldContinueModelText } from './continuation';
import {
  deriveHistoryBudgetTokens,
  deriveNonUserContentCapChars,
  deriveToolResultCapChars,
  estimateMessagesTokens,
} from './token-config';
import {
  formatWebSearchResult,
  hasUsableSearchResults,
  webSearch,
  fetchUrl,
  buildSystemPromptBase,
} from './shared-tools';
import { shouldWatchdogVisibleTool, stringifyStreamValue, visibleTextFromStreamPart } from './stream-output';
import {
  browserNavigate,
  browserSnapshot,
  browserClick,
  browserType,
  browserScroll,
  browserBack,
  browserEval,
  browserTaskStart,
  browserTaskFinish,
  browserWaitForIdle,
  browserPressKey,
  browserListFrames,
  browserSwitchFrame,
  // Electron Native tools
  browserFind,
  browserExportCookies,
  browserImportCookies,
  browserClearSession,
  browserZoom,
  browserExportPDF,
  browserReadClipboard,
  browserWriteClipboard,
  browserPageHealth,
  // Visual Overlay tools
  browserShowOverlay,
  browserClearOverlay,
  browserHighlightRef,
  browserStopFind,
  // Advanced CDP tools
  browserUploadFile,
  browserCaptureNetwork,
  browserListNetworkRequests,
  browserGetNetworkResponse,
  browserSnapshotState,
  browserRestoreState,
  browserHover,
  browserListDownloads,
  notifyBrowserStepStart,
} from './browser-use';

const REDACTED_THINK_OPEN = '<think>';
const REDACTED_THINK_CLOSE = '</think>';

// System prompt: shared base (from shared-tools.ts)
function getSystemPrompt(cwd: string): string {
  return buildSystemPromptBase(cwd);
}

// ── Agent implementation using Vercel AI SDK ────────────────────────
export class VercelAgent implements IAgent {
  readonly name = 'Vercel AI SDK';

  private window!: BrowserWindow;
  private cwd!: string;
  private model!: string;
  private maxOutputTokens!: number;
  private maxContextTokens!: number;
  private maxToolSteps!: number;
  private apiKey = '';
  private provider!: ReturnType<typeof createOpenAI>;
  private messages: ModelMessage[] = [];
  private abortController: AbortController | null = null;

  private retryCount = 0;
  /** Retries when the provider ends the stream without pairing tool calls to results (MissingToolResults / similar). */
  private missingToolRecoveryAttempts = 0;
  private truncationCount = 0;
  private busy = false;
  private currentTurnSearchResult: { query: string; result: string } | null = null;
  private assistantReasonings: string[] = [];

  init(window: BrowserWindow, config: AgentConfig): void {
    this.window = window;
    this.cwd = config.cwd;
    this.model = config.model;
    this.maxOutputTokens = config.maxOutputTokens;
    this.maxContextTokens = config.maxContextTokens;
    this.maxToolSteps = config.maxToolSteps || 200;
    this.apiKey = config.apiKey || '';

    // Create OpenAI-compatible provider via Vercel AI SDK
    // Custom fetch middleware: fixes Google API's tool_calls[].index type
    // (Google returns string, Vercel SDK expects number → ZodError)
    const patchSSELine = (line: string): string => {
      if (!line.startsWith('data: ') || line === 'data: [DONE]') return line;
      try {
        const data = JSON.parse(line.slice(6));
        const tc = data?.choices?.[0]?.delta?.tool_calls;
        if (Array.isArray(tc)) {
          let patched = false;
          for (let i = 0; i < tc.length; i++) {
            const call = tc[i];
            if (call.index === undefined) {
              call.index = i;
              patched = true;
            } else if (typeof call.index !== 'number') {
              call.index = Number(call.index);
              patched = true;
            }
            if (call.extra_content !== undefined) {
              delete call.extra_content;
              patched = true;
            }
          }
          if (patched) {
            return 'data: ' + JSON.stringify(data);
          }
        }
      } catch (patchErr: unknown) {
        console.warn('[VercelAgent] patchSSELine parse failed:', getErrorMessage(patchErr));
      }
      return line;
    };

    this.provider = createOpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || 'sk-placeholder',
      compatibility: 'compatible',
      fetch: async (url, init) => {
        let numAssistants = 0;
        if (init?.body && typeof init.body === 'string') {
          try {
            const bodyObj = JSON.parse(init.body);
            if (Array.isArray(bodyObj.messages)) {
              for (const msg of bodyObj.messages) {
                if (msg.role === 'assistant') {
                  const rc = this.assistantReasonings[numAssistants];
                  if (rc) msg.reasoning_content = rc;
                  numAssistants++;
                }
              }
              init.body = JSON.stringify(bodyObj);
              // Also update content-length if present, though fetch usually recalculates it
              if (init.headers) {
                const headers = new Headers(init.headers);
                headers.delete('content-length');
                init.headers = Object.fromEntries(headers.entries());
              }
            }
          } catch (parseErr: unknown) {
            console.warn('[VercelAgent] SSE patch skipped line:', getErrorMessage(parseErr));
          }
        }

        const response = await globalThis.fetch(url, init);
        if (!response.body) return response;
        const originalBody = response.body;

        let sseBuffer = '';
        let sseReasoning = '';
        const assistantReasonings = this.assistantReasonings;
        const transform = new TransformStream({
          transform(chunk, controller) {
            const text = new TextDecoder().decode(chunk);
            sseBuffer += text;
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() ?? '';
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const data = JSON.parse(line.slice(6)) as { choices?: { delta?: { reasoning_content?: string } }[] };
                  if (data?.choices?.[0]?.delta?.reasoning_content) {
                    sseReasoning += data.choices[0].delta.reasoning_content;
                  }
                } catch {
                  /* ignore malformed SSE chunk */
                }
              }
              controller.enqueue(new TextEncoder().encode(patchSSELine(line) + '\n'));
            }
          },
          flush(controller) {
            if (sseBuffer.trim()) {
              const line = sseBuffer;
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const data = JSON.parse(line.slice(6)) as { choices?: { delta?: { reasoning_content?: string } }[] };
                  if (data?.choices?.[0]?.delta?.reasoning_content) {
                    sseReasoning += data.choices[0].delta.reasoning_content;
                  }
                } catch {
                  /* ignore malformed SSE chunk */
                }
              }
              controller.enqueue(new TextEncoder().encode(patchSSELine(line) + '\n'));
            }
            assistantReasonings[numAssistants] = sseReasoning || '';
          },
        });
        return new Response(originalBody.pipeThrough(transform), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    });

    console.log(`[VercelAgent] Initialized with Vercel AI SDK, model=${this.model}, baseUrl=${config.baseUrl}, maxOutputTokens=${this.maxOutputTokens}, maxContextTokens=${this.maxContextTokens}`);

  }

  private send(channel: string, ...args: unknown[]) {
    try { this.window.webContents.send(channel, ...args); } catch (sendErr: unknown) {
      console.warn('[VercelAgent] IPC send failed:', getErrorMessage(sendErr));
    }
  }

  async handleMessage(content: string): Promise<void> {
    if (this.busy) {
      this.abort();
      await new Promise(r => setTimeout(r, 500));
    }
    // Guard: API key must be configured
    if (!this.apiKey) {
      this.send('chat-stream-start', '');
      this.send('chat-stream-token', '⚠️ **API Key 未配置**\n\n请在 Settings (⌘,) 中配置你的 API Key，然后重试。\n\n支持的服务商：Volcengine Ark、SiliconFlow、OpenAI、DeepSeek 等 OpenAI-compatible 接口。');
      this.send('chat-stream-end', '');
      this.send('chat-status', 'idle');
      return;
    }
    this.busy = true;
    this.missingToolRecoveryAttempts = 0;
    this.messages.push({ role: 'user', content });
    this.send('chat-stream-start', '');
    try {
      await this.runStream();
    } finally {
      this.busy = false;
      this.send('chat-stream-end', '');
      this.send('chat-status', 'idle');
    }
  }

  async handleMessageWithImages(content: string, imageDataUrls: string[]): Promise<void> {
    if (this.busy) {
      this.abort();
      await new Promise(r => setTimeout(r, 500));
    }
    // Guard: API key must be configured
    if (!this.apiKey) {
      this.send('chat-stream-start', '');
      this.send('chat-stream-token', '⚠️ **API Key 未配置**\n\n请在 Settings (⌘,) 中配置你的 API Key，然后重试。');
      this.send('chat-stream-end', '');
      this.send('chat-status', 'idle');
      return;
    }
    this.busy = true;
    this.missingToolRecoveryAttempts = 0;
    // Build multimodal message with text + image parts (Vercel AI SDK format)
    const parts: UserContentPart[] = [{ type: 'text', text: content }];
    for (const dataUrl of imageDataUrls) {
      // dataUrl format: "data:image/png;base64,iVBOR..."
      const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) {
        parts.push({ type: 'image', image: match[2], mimeType: match[1] });
      }
    }
    this.messages.push({ role: 'user', content: parts });
    this.send('chat-stream-start', '');
    try {
      await this.runStream();
    } finally {
      this.busy = false;
      this.send('chat-stream-end', '');
      this.send('chat-status', 'idle');
    }
  }

  resetConversation(): void {
    if (this.busy) this.abort();
    this.messages = [];
  }

  loadHistory(history: HistoryMessage[]): void {
    if (this.busy) this.abort();
    this.messages = history.map(m => {
      const isImageAttachment = (a: HistoryAttachment) => a.type === 'image' && !!a.dataUrl;
      if (m.role === 'user' && m.attachments?.some(isImageAttachment)) {
        const imageParts = m.attachments
          .filter(isImageAttachment)
          .map((a) => ({
            type: 'image' as const,
            image: new URL(a.dataUrl!),
          }));
        
        return {
          role: 'user',
          content: [
            { type: 'text' as const, text: m.content },
            ...imageParts
          ]
        };
      }
      return { role: m.role, content: m.content } as ModelMessage;
    }) as ModelMessage[];
  }

  abort(): void { this.abortController?.abort(); this.abortController = null; }

  /** Clean up resources (file watcher, timers) before disposal */
  destroy(): void {
    this.abort();
  }

  /** Keep message history within context window limits */
  private pruneHistory(): void {
    const MAX_MESSAGES = 50;
    const maxContentLen = deriveNonUserContentCapChars(this.maxContextTokens);
    const maxHistoryTokens = deriveHistoryBudgetTokens(this.maxContextTokens);
    // Sliding window: drop oldest messages (keep system-relevant context)
    if (this.messages.length > MAX_MESSAGES) {
      // Keep first 2 (initial context) + most recent messages
      this.messages = [
        ...this.messages.slice(0, 2),
        ...this.messages.slice(-(MAX_MESSAGES - 2)),
      ];
      console.log(`[VercelAgent] Pruned history to ${this.messages.length} messages`);
    }
    // Truncate oversized tool results to prevent context bloat
    for (const msg of this.messages) {
      if (typeof msg.content === 'string' && msg.content.length > maxContentLen && msg.role !== 'user') {
        msg.content = msg.content.slice(0, maxContentLen) + '\n\n[DISPLAY_TRUNCATED: Content was trimmed to fit context window. The original data was fully collected. Do NOT retry the tool call.]';
      }
    }

    while (this.messages.length > 12 && estimateMessagesTokens(this.messages) > maxHistoryTokens) {
      this.messages.shift();
    }

    // ── Post-prune: repair broken tool-call / tool-result pairs ──
    // Both slice (sliding window) and shift (token budget) can cut through
    // assistant(tool-call) ↔ tool(tool-result) boundaries, leaving orphans
    // that trigger AI_MissingToolResultsError on the next streamText call.
    this.repairToolPairs();
  }

  /**
   * Remove orphaned tool-calls (assistant content parts with no matching tool-result)
   * and orphaned tool-results (tool messages with no matching tool-call).
   * Loops until stable because removing one can orphan another.
   */
  private repairToolPairs(): void {
    let prevLen = this.messages.length + 1;
    let passes = 0;
    while (this.messages.length < prevLen && passes < 5) {
      prevLen = this.messages.length;
      passes++;

      // Collect all tool-call IDs from assistant messages
      const allToolCallIds = new Set<string>();
      for (const m of this.messages) {
        if (m.role === 'assistant' && Array.isArray(m.content)) {
          for (const p of m.content) {
            if (p.type === 'tool-call' && p.toolCallId) allToolCallIds.add(p.toolCallId);
          }
        }
      }

      // Collect all tool-result IDs from tool messages
      const allToolResultIds = new Set<string>();
      for (const m of this.messages) {
        if (m.role === 'tool') {
          const parts = Array.isArray(m.content) ? m.content : [m];
          for (const p of parts) {
            if (p.toolCallId) allToolResultIds.add(p.toolCallId);
          }
        }
      }

      const cleaned: typeof this.messages = [];
      for (const m of this.messages) {
        if (m.role === 'assistant' && Array.isArray(m.content)) {
          // Strip tool-calls that have no matching tool-result
          const filteredContent = (m.content as ToolCallContentPart[]).filter((p) => {
            if (p.type === 'tool-call' && p.toolCallId && !allToolResultIds.has(p.toolCallId)) {
              console.log(`[VercelAgent] pruneHistory: stripping orphaned tool-call ${p.toolCallId} (${p.toolName})`);
              return false;
            }
            return true;
          });
          if (filteredContent.length > 0) {
            cleaned.push({ ...m, content: filteredContent });
          }
          // else: assistant message had only orphaned tool-calls → drop entirely
        } else if (m.role === 'tool') {
          // Strip tool-results that have no matching tool-call
          const parts = Array.isArray(m.content) ? m.content : [m];
          const hasMatchingCall = parts.some((p: ToolCallContentPart) => p.toolCallId && allToolCallIds.has(p.toolCallId));
          if (hasMatchingCall) {
            cleaned.push(m);
          } else {
            const ids = parts.map((p: ToolCallContentPart) => p.toolCallId).filter(Boolean).join(', ');
            console.log(`[VercelAgent] pruneHistory: stripping orphaned tool-result ${ids}`);
          }
        } else {
          cleaned.push(m);
        }
      }
      this.messages = cleaned;
    }
    if (passes > 1) {
      console.log(`[VercelAgent] repairToolPairs: ${passes} passes (now ${this.messages.length} messages)`);
    }
  }

  private getToolResultCapChars(): number {
    return deriveToolResultCapChars(this.maxContextTokens);
  }
  private getTools() {
    const cwd = this.cwd;
    const send = this.send.bind(this);

    return {
      web_search: tool({
        description: 'Search the web for real-time information. Use this when you need current data, news, or anything beyond your training cutoff.',
        inputSchema: z.object({
          query: z.string().describe('Search query'),
          engine: z.enum(['google', 'sogou', 'baidu', 'bing']).optional().describe('Search engine to use. Default: google. Options: google, sogou (Chinese), baidu (Chinese), bing.'),
        }),
        execute: async ({ query, engine }) => {
          if (this.currentTurnSearchResult && hasUsableSearchResults(this.currentTurnSearchResult.result)) {
            // Only block truly duplicate queries (>60% word overlap); allow different-angle searches
            const prevWords = new Set(this.currentTurnSearchResult.query.toLowerCase().split(/\s+/));
            const curWords = query.toLowerCase().split(/\s+/);
            const overlap = curWords.filter(w => prevWords.has(w)).length;
            const similarity = curWords.length > 0 ? overlap / curWords.length : 0;
            if (similarity > 0.6) {
              const reused = [
                `Skipped duplicate web_search for "${query}".`,
                `A usable search result already exists in this turn from query "${this.currentTurnSearchResult.query}".`,
                'Use the previous snippets to answer now.',
                '',
                this.currentTurnSearchResult.result,
              ].join('\n');
              send('chat-stream-token', `\n已拦截重复浏览器搜索：${query}\n`);
              return formatWebSearchResult(query, reused);
            }
          }
          const engineLabel = engine || 'google';
          send('chat-stream-token', `\n正在用 ${engineLabel} 搜索：${query}\n`);
          const started = Date.now();
          const rawResult = await webSearch(query, engine);
          const result = formatWebSearchResult(query, rawResult);
          if (hasUsableSearchResults(rawResult)) {
            this.currentTurnSearchResult = { query, result: rawResult };
          }
          const seconds = ((Date.now() - started) / 1000).toFixed(1);
          const preview = rawResult
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .slice(0, 5)
            .join('\n');
          send(
            'chat-stream-token',
            preview
              ? `\n搜索解析完成（${seconds}s），已提取到：\n\`\`\`search-snippet\n${preview}\n\`\`\`\n`
              : `\n搜索完成（${seconds}s），但没有提取到可用摘要。\n`,
          );
          return result;
        },
      }),

      run_command: tool({
        description: 'Run a shell command on the user\'s local machine. This runs in the project directory by default. Used for running scripts (e.g. python, node), installing dependencies, or generic OS commands. Use responsibly.',
        inputSchema: z.object({ command: z.string().describe('The shell command to execute') }),
        execute: async ({ command }) => executeRunCommand(command, cwd),
      }),

      read_file: tool({
        description: 'Read the contents of a local file.',
        inputSchema: z.object({ filepath: z.string().describe('Absolute or relative path to the file') }),
        execute: async ({ filepath }) => {
          try {
            const fullPath = path.resolve(cwd, filepath);
            const content = await fs.readFile(fullPath, 'utf8');
            return content;
          } catch (e: unknown) {
            return `Error reading file: ${getErrorMessage(e)}`;
          }
        },
      }),

      write_file: tool({
        description: 'Write string content to a local file. This will overwrite the file if it exists.',
        inputSchema: z.object({ 
          filepath: z.string().describe('Absolute or relative path to the file'),
          content: z.string().describe('The content to write') 
        }),
        execute: async ({ filepath, content }) => {
          try {
            const fullPath = path.resolve(cwd, filepath);
            await fs.mkdir(path.dirname(fullPath), { recursive: true });
            await fs.writeFile(fullPath, content, 'utf8');
            return `Successfully wrote to ${fullPath}`;
          } catch (e: unknown) {
            return `Error writing file: ${getErrorMessage(e)}`;
          }
        },
      }),

      fetch_url: tool({
        description: 'Fetch and read content from a URL. Returns text extracted from the page. Does NOT execute JavaScript — for JS-rendered pages, use browse_page instead.',
        inputSchema: z.object({ url: z.string().describe('URL to fetch') }),
        execute: async ({ url }) => {
          return await fetchUrl(url);
        },
      }),

      browse_page: tool({
        description: 'Open a URL in a real browser with full JavaScript rendering, then execute a custom script to interact with and extract data from the page. Use this for: (1) JS-rendered SPAs (React/Vue/dynamic tables), (2) pages requiring clicks/scrolls/form fills, (3) data extraction from complex layouts. The script runs in page context with full DOM access and can use async/await. It MUST return a string.',
        inputSchema: z.object({
          url: z.string().describe('URL to open'),
          script: z.string().describe('JavaScript to execute in page context. Can use async/await for multi-step interactions (click → wait → extract). MUST return a string.'),
          wait_before_script: z.number().optional().describe('Milliseconds to wait after page loads before running script. Default: 2000. Increase for slow-loading pages.'),
          timeout: z.number().optional().describe('Total timeout in milliseconds. Default: 30000.'),
        }),
        execute: async ({ url, script, wait_before_script, timeout }) => {
          send('chat-stream-token', `\n正在打开浏览器页面：${url}\n`);
          const started = Date.now();
          const result = await browsePage({ url, script, waitMs: wait_before_script ?? 2000, timeoutMs: timeout ?? 30000 });
          const seconds = ((Date.now() - started) / 1000).toFixed(1);
          send('chat-stream-token', `\n页面解析完成（${seconds}s）：${result.slice(0, 500)}${result.length > 500 ? '\n...(truncated)' : ''}\n`);
          return result;
        },
      }),

      // ── Browser-Use: Long-running browser agent tools ──
      browser_task_start: tool({
        description:
          'Begin a named multi-step browser session. Call once when starting a long interactive browser workflow so all browser_* steps appear under one timeline heading in the UI. Always pass a short goal string the user can read.',
        inputSchema: z.object({
          goal: z.string().describe('Short goal shown in the browser panel timeline, e.g. "Find invoice PDF on billing portal".'),
        }),
        execute: async ({ goal }) => browserTaskStart(goal),
      }),

      browser_task_finish: tool({
        description:
          'End the current browser session started with browser_task_start. Optionally summarize what was accomplished for the user-visible banner.',
        inputSchema: z.object({
          summary: z.string().optional().describe('One or two lines describing outcome (shown in the browser panel).'),
        }),
        execute: async ({ summary }) => browserTaskFinish(summary),
      }),

      browser_navigate: tool({
        description:
          'Navigate the built-in browser to a URL. The browser tab opens automatically. Auto-waits for page idle after navigation. For multi-step flows, call browser_task_start(goal) first so steps stay grouped.',
        inputSchema: z.object({ url: z.string().describe('URL to navigate to') }),
        execute: async ({ url }) => {
          notifyBrowserStepStart('navigate', { url });
          return await browserNavigate(url);
        },
      }),

      browser_snapshot: tool({
        description: 'Get a text snapshot of the current page with interactive element references [e1], [e2], etc. Use this to see what is on the page and find elements to interact with. Always call this BEFORE clicking or typing. The snapshot will show a ⚠️ PAGE STATE: LOADING warning if the page is still processing — if you see this, call browser_wait_for_idle before interacting.',
        inputSchema: z.object({}),
        execute: async () => {
          notifyBrowserStepStart('snapshot', {});
          return await browserSnapshot();
        },
      }),

      browser_click: tool({
        description: 'Click an element by its reference ID from browser_snapshot. Example: ref="e3" clicks the third interactive element. Auto-waits for page idle after click. If the result says [DISABLED], the element is not clickable yet — wait and retry.',
        inputSchema: z.object({ ref: z.string().describe('Element reference from snapshot, e.g. "e3"') }),
        execute: async ({ ref }) => {
          notifyBrowserStepStart('click', { ref });
          return await browserClick(ref);
        },
      }),

      browser_hover: tool({
        description: 'Hover over an element by its reference ID from browser_snapshot. Use this to reveal CSS dropdown menus or tooltips before taking another snapshot.',
        inputSchema: z.object({ ref: z.string().describe('Element reference from snapshot, e.g. "e3"') }),
        execute: async ({ ref }) => {
          notifyBrowserStepStart('hover', { ref });
          return await browserHover(ref);
        },
      }),

      browser_type: tool({
        description: 'Type text into an input/textarea element by its reference ID. Clears existing content first.',
        inputSchema: z.object({
          ref: z.string().describe('Element reference from snapshot'),
          text: z.string().describe('Text to type'),
        }),
        execute: async ({ ref, text }) => {
          notifyBrowserStepStart('type', { ref, text });
          return await browserType(ref, text);
        },
      }),

      browser_scroll: tool({
        description: 'Scroll the page up or down to see more content.',
        inputSchema: z.object({ direction: z.enum(['up', 'down']).describe('Scroll direction') }),
        execute: async ({ direction }) => browserScroll(direction),
      }),

      browser_back: tool({
        description: 'Go back to the previous page in browser history.',
        inputSchema: z.object({}),
        execute: async () => browserBack(),
      }),

      browser_eval: tool({
        description: 'Execute arbitrary JavaScript in the current page context. Use for complex interactions not covered by other browser tools. Script MUST return a string. IMPORTANT: If extracting images, do NOT return base64 data — it will be auto-saved to disk and a file path returned instead.',
        inputSchema: z.object({ script: z.string().describe('JavaScript to execute in page context') }),
        execute: async ({ script }) => {
          notifyBrowserStepStart('eval', { script });
          const evalResult = await browserEval(script, cwd);
          // Auto-save large text results to file to avoid context truncation loops
          if (evalResult.length > 50_000 && !evalResult.startsWith('Image saved to')) {
            const filename = `scratch/browser_eval_${Date.now()}.txt`;
            const fp = path.resolve(cwd, filename);
            await fs.mkdir(path.dirname(fp), { recursive: true });
            await fs.writeFile(fp, evalResult, 'utf8');
            const lineCount = evalResult.split('\n').length;
            const preview = evalResult.slice(0, 2000);
            return `Data saved to ${filename} (${evalResult.length} chars, ${lineCount} lines).\n\nPreview (first 2000 chars):\n${preview}\n\n[Full data is in the file. Do NOT re-run this script — data collection is complete.]`;
          }
          return evalResult;
        },
      }),

      browser_wait_for_idle: tool({
        description: 'Explicitly wait for the page to become idle (no loading spinners, no DOM changes, no pending requests). Use after submitting forms, triggering AI generation, or any action that causes async processing. Default timeout: 15s, max: 120s.',
        inputSchema: z.object({
          timeout_ms: z.number().optional().describe('Maximum wait time in milliseconds. Default: 15000. For AI generation tasks, use 60000-120000.'),
        }),
        execute: async ({ timeout_ms }) => {
          notifyBrowserStepStart('wait_idle', { timeout_ms });
          return await browserWaitForIdle(timeout_ms);
        },
      }),

      browser_press_key: tool({
        description: 'Press a special key (Enter, Tab, Escape, Backspace, Delete, Arrow keys, Space) using native keyboard simulation. Use this to submit forms (Enter), navigate tabs (Tab), or dismiss dialogs (Escape). This fires at the Chromium engine level — identical to a physical key press.',
        inputSchema: z.object({
          key: z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']).describe('Key to press'),
        }),
        execute: async ({ key }) => browserPressKey(key),
      }),

      browser_list_frames: tool({
        description: 'List all frames (main page + iframes) with their URLs and indices. Use this when browser_snapshot shows few or no interactive elements — the login form or content might be inside an iframe. Each frame has an index you can pass to browser_switch_frame.',
        inputSchema: z.object({}),
        execute: async () => browserListFrames(),
      }),

      browser_switch_frame: tool({
        description: 'Switch browser tool execution context to a specific iframe by index. After switching, browser_snapshot/click/type/eval will operate inside that frame. Use browser_list_frames first to see available frames. Pass frameIndex=-1 to switch back to the main frame.',
        inputSchema: z.object({
          frameIndex: z.number().describe('Frame index from browser_list_frames. Use -1 to return to main frame.'),
        }),
        execute: async ({ frameIndex }) => {
          notifyBrowserStepStart('switch_frame', { frameIndex });
          return await browserSwitchFrame(frameIndex);
        },
      }),

      // ── Electron Native tools (shared with builtin.ts) ──

      browser_find: tool({
        description: 'Search for text on the current page using Chromium native find-in-page. Works across Shadow DOM and iframes. Returns match count and scrolls to first match.',
        inputSchema: z.object({ text: z.string().describe('Text to search for') }),
        execute: async ({ text }) => browserFind(text),
      }),

      browser_stop_find: tool({
        description: 'Stop find-in-page and clear all match highlights.',
        inputSchema: z.object({}),
        execute: async () => browserStopFind(),
      }),

      browser_export_cookies: tool({
        description: 'Export browser session cookies to a JSON file. Use to save login state for later restore. Pass url to export only cookies for that domain (e.g. https://google.com). Auto-saves to scratch/ folder, returns the file path.',
        inputSchema: z.object({
          url: z.string().optional().describe('Optional: export only cookies for this URL/domain. Omit to export all cookies.'),
        }),
        execute: async ({ url }) => browserExportCookies(url),
      }),

      browser_import_cookies: tool({
        description: 'Import cookies from a previously exported JSON file to restore a login session.',
        inputSchema: z.object({
          file_path: z.string().describe('Path to the cookies JSON file'),
        }),
        execute: async ({ file_path }) => browserImportCookies(file_path),
      }),

      browser_clear_session: tool({
        description: 'Clear all cookies, localStorage, and cache. Use to start fresh.',
        inputSchema: z.object({}),
        execute: async () => browserClearSession(),
      }),

      browser_zoom: tool({
        description: 'Set page zoom level. Use when text is too small to read or page layout is broken.',
        inputSchema: z.object({
          factor: z.number().describe('Zoom factor: 1.0=100%, 0.5=50%, 2.0=200%'),
        }),
        execute: async ({ factor }) => browserZoom(factor),
      }),

      browser_export_pdf: tool({
        description: 'Export the current page as a PDF file to disk. No print dialog — direct Chromium print pipeline.',
        inputSchema: z.object({
          output_path: z.string().optional().describe('Optional absolute path to save the PDF. Defaults to ~/Downloads/page_<timestamp>.pdf'),
        }),
        execute: async ({ output_path }) => browserExportPDF(output_path),
      }),

      browser_read_clipboard: tool({
        description: 'Read the current system clipboard text. No user gesture needed (Electron Native privilege).',
        inputSchema: z.object({}),
        execute: async () => browserReadClipboard(),
      }),

      browser_write_clipboard: tool({
        description: 'Write text to the system clipboard. Useful for passing extracted page data to other apps.',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => browserWriteClipboard(text),
      }),

      browser_page_health: tool({
        description: 'Get a quick page status summary: URL, title, loading state, network activity, error count, zoom, navigation history. Zero JS injection — instant read from Electron Native APIs. Use before snapshot to understand page state.',
        inputSchema: z.object({}),
        execute: async () => browserPageHealth(),
      }),

      browser_show_overlay: tool({
        description: 'Render ALL interactive elements as blue highlighted boxes ("X-ray vision" mode). Uses CDP Overlay — no DOM injection. Shows exactly what the agent can see and click. Run after browser_snapshot.',
        inputSchema: z.object({}),
        execute: async () => browserShowOverlay(),
      }),

      browser_clear_overlay: tool({
        description: 'Remove all element highlight overlays from the page.',
        inputSchema: z.object({}),
        execute: async () => browserClearOverlay(),
      }),

      browser_highlight_ref: tool({
        description: 'Highlight a specific element ref with an orange box for 3 seconds. Use to verify you are targeting the right element before clicking.',
        inputSchema: z.object({
          ref: z.string().describe('Element ref from browser_snapshot, e.g. "e3"'),
        }),
        execute: async ({ ref }) => browserHighlightRef(ref),
      }),

      browser_upload_file: tool({
        description: 'Set file(s) on a file input element — bypasses the native OS file picker dialog. The ref MUST be an <input type="file"> from browser_snapshot. Use this for email attachments, avatar upload, document submission, etc.',
        inputSchema: z.object({
          ref: z.string().describe('Element ref of the file input (e.g. "e5")'),
          file_paths: z.array(z.string()).describe('Array of absolute file paths to upload'),
        }),
        execute: async ({ ref, file_paths }) => browserUploadFile(ref, file_paths),
      }),

      browser_capture_network: tool({
        description: 'Capture the next network response matching a URL pattern. Call this BEFORE triggering the action that makes the request (e.g. click search). Returns the raw response body (JSON, HTML, etc.). Perfect for extracting API data from React/Vue SPAs.',
        inputSchema: z.object({
          url_pattern: z.string().describe('Substring to match in request URLs (e.g. "/api/search", "graphql")'),
          timeout_ms: z.number().optional().describe('Max wait time in ms. Default: 15000.'),
        }),
        execute: async ({ url_pattern, timeout_ms }) => browserCaptureNetwork(url_pattern, timeout_ms),
      }),

      browser_list_network_requests: tool({
        description: 'List recently intercepted background API/JSON network requests. Returns Request IDs and URLs. Use this if the data you want was loaded dynamically via XHR/Fetch, saving you from parsing complex DOM.',
        inputSchema: z.object({}),
        execute: async () => browserListNetworkRequests(),
      }),

      browser_get_network_response: tool({
        description: 'Get the JSON response body of a previously intercepted network request by its Request ID. Use browser_list_network_requests first to find the ID.',
        inputSchema: z.object({
          request_id: z.string().describe('The Request ID obtained from browser_list_network_requests'),
        }),
        execute: async ({ request_id }) => browserGetNetworkResponse(request_id),
      }),

      browser_snapshot_state: tool({
        description: 'Take a memory snapshot of the current page state (URL, Cookies, LocalStorage, SessionStorage). Use this before attempting a complex or risky sequence of actions (like filling out a long form or clicking uncertain links). Returns a state_id.',
        inputSchema: z.object({}),
        execute: async () => browserSnapshotState(),
      }),

      browser_restore_state: tool({
        description: 'Instantly rollback the browser to a previously snapshotted state (Cookies, LocalStorage, URL). Use this if you made a mistake, clicked the wrong button, or got stuck on an error page.',
        inputSchema: z.object({
          state_id: z.string().describe('The state_id returned by browser_snapshot_state'),
        }),
        execute: async ({ state_id }) => browserRestoreState(state_id),
      }),

      browser_list_downloads: tool({
        description: 'List recent file downloads triggered by the browser. Returns file paths (like ~/Downloads/file.csv) and their status. You can use read_file on these paths to process the downloaded data.',
        inputSchema: z.object({}),
        execute: async () => browserListDownloads(),
      }),

      render_html: tool({
        description: 'Render a beautiful, rich HTML document directly in the IDE browser panel. Use this for highly visual results like shopping items, social media posts, image galleries, or dashboards. You can use absolute local file paths (e.g. file:///Users/...) directly in src/href attributes.',
        inputSchema: z.object({ html: z.string().describe('The complete HTML document string to render (include <style> tags or Tailwind via CDN for styling).') }),
        execute: async ({ html }) => {
          const allWindows = BrowserWindow.getAllWindows();
          const mainWindow = allWindows.find((w) => w.getTitle()?.includes('DSME')) || allWindows[0];
          if (mainWindow) mainWindow.webContents.send('browser-panel-open');

          this.send('chat-stream-token', `\n正在渲染丰富的 HTML 视图...\n`);
          await browserViewManager.loadHTML(html);
          return 'HTML rendered successfully in the IDE browser panel. Tell the user to look at the browser panel.';
        },
      }),
    };
  }

  // ── Main stream using Vercel AI SDK streamText ──
  private async runStream(): Promise<void> {
    const STREAM_TIMEOUT_MS = 900_000; // 15 min hard timeout — allows for slow image/video generation
    const POST_TOOL_TEXT_TIMEOUT_MS = 600_000; // 10 min — AI image/video generation can take 5+ minutes
    this.currentTurnSearchResult = null;
    // True iterative retry loop (no recursion, no stack growth)
    let forceNoTools = false;
    while (true) {
    this.pruneHistory();
    this.abortController = new AbortController();
    const streamStartedAt = Date.now();
    let fullText = '';
    let modelText = '';
    let modelTextChars = 0;          // ← Pure model text-delta bytes this run (excludes tool output / watchdog notes)
    let sawToolCallPart = false;     // ← Last step emitted a tool-call part (truncation would be on args, not final text)
    let lastEventWasText = false;    // ← Most recent stream event was text-delta (vs tool-call)
    let postToolWatchdogTimedOut = false;
    let visibleToolOutputAt = 0;
    let postToolWatchdog: ReturnType<typeof setTimeout> | null = null;
    const clearPostToolWatchdog = () => {
      if (postToolWatchdog) {
        clearTimeout(postToolWatchdog);
        postToolWatchdog = null;
      }
    };
    const armPostToolWatchdog = (toolName: string | undefined) => {
      if (!shouldWatchdogVisibleTool(toolName)) return;
      clearPostToolWatchdog();
      postToolWatchdog = setTimeout(() => {
        postToolWatchdogTimedOut = true;
        console.warn(`[VercelAgent] ${toolName} returned visible output, but model produced no final text within ${POST_TOOL_TEXT_TIMEOUT_MS}ms. Aborting wait.`);
        this.send(
          'chat-stream-token',
          `\n\n⚠️ 已获得 **${toolName}** 的可见结果，但模型 ${POST_TOOL_TEXT_TIMEOUT_MS / 1000}s 内没有生成最终回复，已停止等待。上方工具输出可直接参考。\n`,
        );
        this.abortController?.abort();
      }, POST_TOOL_TEXT_TIMEOUT_MS);
    };
    // Hard timeout: auto-abort if LLM hangs
    const timeoutId = setTimeout(() => {
      console.warn('[VercelAgent] Stream timeout after 300s — aborting');
      this.abortController?.abort();
    }, STREAM_TIMEOUT_MS);
    let streamHadMissingToolError = false;
    let lastStepNumber = 0;
    try {
      const result = streamText({
        model: this.provider.chat(this.model),
        system: getSystemPrompt(this.cwd),
        messages: this.messages,
        tools: forceNoTools ? undefined : this.getTools(),
        maxOutputTokens: this.maxOutputTokens,
        stopWhen: stepCountIs(this.maxToolSteps),
        abortSignal: this.abortController.signal,

        // Lifecycle callbacks for UI updates
        onStepFinish: ({ stepNumber, text, toolCalls }) => {
          lastStepNumber = stepNumber;
          console.log(`[VercelAgent] Step ${stepNumber} finished: text=${text?.length || 0}ch, tools=${toolCalls?.length || 0}`);
        },

        experimental_onToolCallStart: ({ toolCall }) => {
          const toolName = toolCall.toolName;
          const input = 'input' in toolCall ? toolCall.input : {};
          console.log(`[VercelAgent] Tool start: ${toolName}`, JSON.stringify(input ?? {}).slice(0, 200));
          this.send('chat-status', `tool:${toolName}`);
          const argSummary = formatToolArgs(toolName, input ?? {});
          this.send('chat-stream-token', `\n\n> **${toolName}**${argSummary}\n`);
        },

        experimental_onToolCallFinish: (evt) => {
          const toolName = evt.toolCall.toolName;
          const durationMs = evt.durationMs;
          const error = evt.success ? undefined : evt.error;
          if (error) {
            console.error(`[VercelAgent] Tool ${toolName} failed after ${durationMs}ms:`, error);
          } else {
            console.log(`[VercelAgent] Tool ${toolName} done in ${durationMs}ms`);
          }
          this.send('chat-status', 'thinking');
        },
      });

      // Consume the full stream (text + tool events)
      // Collapse model fenced “think” blocks into <details> for display (see REDACTED_THINK_* delimiters)
      let insideThink = false;
      let thinkBuffer = '';
      const toolCallNames = new Map<string, string>();

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta': {
            const rawDelta = (part as VercelStreamPart).text ?? (part as VercelStreamPart).textDelta;
            const delta = rawDelta == null ? '' : typeof rawDelta === 'string' ? rawDelta : String(rawDelta);
            if (delta.length) {
              modelText += delta;
              modelTextChars += delta.length;
              lastEventWasText = true;
            }
            if (delta.trim()) {
              if (visibleToolOutputAt) {
                console.log(`[VercelAgent] Model text resumed ${(Date.now() - visibleToolOutputAt) / 1000}s after visible tool output`);
                visibleToolOutputAt = 0;
              }
              clearPostToolWatchdog();
            }
            if (insideThink) {
              thinkBuffer += delta;
              const endIdx = thinkBuffer.indexOf(REDACTED_THINK_CLOSE);
              if (endIdx !== -1) {
                // Think block ended — emit buffered content as collapsible, then text after
                insideThink = false;
                const thinkContent = thinkBuffer.slice(0, endIdx);
                const afterThink = thinkBuffer.slice(endIdx + REDACTED_THINK_CLOSE.length);
                thinkBuffer = '';
                // Emit as collapsible details block
                const collapsed = `\n<details>\n<summary>💭 思考过程</summary>\n\n${thinkContent.trim()}\n\n</details>\n`;
                fullText += collapsed;
                this.send('chat-stream-token', collapsed);
                if (afterThink) {
                  fullText += afterThink;
                  this.send('chat-stream-token', afterThink);
                }
              }
            } else {
              const thinkIdx = delta.indexOf(REDACTED_THINK_OPEN);
              if (thinkIdx !== -1) {
                const beforeThink = delta.slice(0, thinkIdx);
                if (beforeThink) {
                  fullText += beforeThink;
                  this.send('chat-stream-token', beforeThink);
                }
                insideThink = true;
                thinkBuffer = delta.slice(thinkIdx + REDACTED_THINK_OPEN.length);
                // Check if closing marker also in this chunk
                const endIdx = thinkBuffer.indexOf(REDACTED_THINK_CLOSE);
                if (endIdx !== -1) {
                  insideThink = false;
                  const thinkContent = thinkBuffer.slice(0, endIdx);
                  const afterThink = thinkBuffer.slice(endIdx + REDACTED_THINK_CLOSE.length);
                  thinkBuffer = '';
                  const collapsed = `\n<details>\n<summary>💭 思考过程</summary>\n\n${thinkContent.trim()}\n\n</details>\n`;
                  fullText += collapsed;
                  this.send('chat-stream-token', collapsed);
                  if (afterThink) {
                    fullText += afterThink;
                    this.send('chat-stream-token', afterThink);
                  }
                }
              } else {
                fullText += delta;
                this.send('chat-stream-token', delta);
              }
            }
            break;
          }
          case 'tool-call': {
            const toolCallId = (part as VercelStreamPart).toolCallId ?? (part as VercelStreamPart).id;
            const toolName = (part as VercelStreamPart).toolName;
            if (toolCallId && toolName) toolCallNames.set(toolCallId, toolName);
            sawToolCallPart = true;
            lastEventWasText = false;
            break;
          }
          case 'error': {
            const e = (part as VercelStreamPart).error;
            const msg = typeof e?.message === 'string' ? e.message : String(e ?? 'stream error');
            const ename = typeof (e as { name?: string })?.name === 'string' ? (e as { name?: string }).name : '';
            if (
              /tool result(?:s)? (?:is|are) missing for tool call/i.test(msg) ||
              /missing for tool call/i.test(msg) ||
              /MissingTool|AI_MissingToolResultsError/i.test(ename)
            ) {
              streamHadMissingToolError = true;
            }
            console.error('[VercelAgent] Stream error:', e);
            const missingToolHint =
              /tool result(?:s)? (?:is|are) missing for tool call/i.test(msg) || /missing for tool call/i.test(msg)
                ? ' *（工具链未闭合：随后可能自动重试；若反复出现请新开对话或换模型。）*'
                : '';
            this.send('chat-stream-token', `\n\n⚠️ **流式错误** — ${msg.slice(0, 800)}${missingToolHint}\n`);
            break;
          }
          case 'tool-error': {
            const e = (part as VercelStreamPart).error ?? part;
            const msg = typeof e === 'string' ? e : e?.message ?? JSON.stringify(e);
            console.error('[VercelAgent] Tool stream error:', e);
            this.send('chat-stream-token', `\n\n⚠️ **工具错误** — ${String(msg).slice(0, 800)}\n`);
            break;
          }
          case 'tool-result':
          case 'tool-output-available':
          case 'tool-output-error':
          case 'tool-output-denied': {
            const toolCallId = (part as VercelStreamPart).toolCallId ?? (part as VercelStreamPart).id;
            const toolName = (part as VercelStreamPart).toolName ?? (toolCallId ? toolCallNames.get(toolCallId) : undefined);
            const visible = visibleTextFromStreamPart({ ...(part as VercelStreamPart), toolName }, this.getToolResultCapChars());
            if (visible) {
              fullText += visible;
              this.send('chat-stream-token', visible);
              visibleToolOutputAt = Date.now();
              console.log(`[VercelAgent] Visible tool output from ${toolName ?? 'unknown'} at +${((visibleToolOutputAt - streamStartedAt) / 1000).toFixed(1)}s (${visible.length}ch)`);
              armPostToolWatchdog(toolName);
            }
            break;
          }
        }
      }

      // Get final response messages for conversation history
      const response = await result.response;
      const finishReason = await result.finishReason;
      // In ai SDK v6 assistant messages use `content: AssistantContent` (string | (TextPart|ToolCallPart|…)[]).
      // There is NO legacy `tool_calls` field — inspect `content` parts directly.
      const hadToolCalls = (response.messages ?? []).some((m: ModelMessage) => {
        if (m.role !== 'assistant') return false;
        const c = m.content;
        if (Array.isArray(c)) return c.some((p: ToolCallContentPart) => p?.type === 'tool-call');
        return false;
      });
      // Robust signal: did the stream end while the model was emitting final text
      // (rather than tool-call args)? Combine message-shape check with live event tracking.
      const lastAssistantMsg = [...(response.messages ?? [])].reverse().find((m: ModelMessage) => m.role === 'assistant');
      const lastMsgHasToolCall = Array.isArray(lastAssistantMsg?.content) &&
        (lastAssistantMsg!.content as ToolCallContentPart[]).some((p) => p?.type === 'tool-call');
      const lastStepWasText = (lastEventWasText && modelTextChars > 0) || (!!lastAssistantMsg && !lastMsgHasToolCall);
      console.log(`[VercelAgent] Stream complete: text=${fullText.length}ch, modelTextChars=${modelTextChars}, hadTools=${hadToolCalls}, sawToolCallPart=${sawToolCallPart}, lastEventWasText=${lastEventWasText}, lastStepText=${lastStepWasText}, finishReason=${finishReason}`);

      // ── Handle output truncation ──
      // Two cases trigger automatic continuation (capped at 5 iterations):
      //   A. finish_reason='length' — hard token-cap cutoff.
      //   B. finish_reason='stop' but the visible text ends mid-sentence — some providers
      //      (Volcengine Doubao, etc.) sporadically self-terminate after tool rounds while
      //      still inside a Chinese clause. We detect this by tail punctuation.
      // We only continue when the last stream step was model TEXT (not tool-call args).
      const modelTail = modelText.replace(/\s+$/, '').slice(-12);
      const isLengthTrunc = finishReason === 'length' && lastStepWasText;
      const isSoftTrunc = shouldContinueModelText({
        finishReason,
        modelText,
        lastStepWasText,
        lastMessageHasToolCall: !!lastMsgHasToolCall,
      });
      // Some providers report 'unknown'/'other'/'error' when SSE is cut mid-stream.
      const fr = String(finishReason ?? '');
      const isAmbiguousTrunc =
        (fr === 'unknown' || fr === 'other' || fr === 'error') &&
        lastStepWasText && modelTextChars > 0;
      // ── Empty-response case ──
      // Model produced ZERO visible text this run. Common Doubao/GLM failure mode:
      // after a tool round (or even immediately) the model self-terminates with
      // finish_reason='stop' / 'tool-calls' but no answer text. Retry with a nudge.
      const isEmptyResponse =
        modelTextChars === 0 &&
        (fr === 'stop' || fr === 'tool-calls' || fr === '' || fr === 'unknown' || fr === 'other');

      if (isLengthTrunc || isSoftTrunc || isAmbiguousTrunc || isEmptyResponse) {
        this.truncationCount = (this.truncationCount || 0) + 1;
        if (this.truncationCount >= 5) {
          console.error('[VercelAgent] Max consecutive truncations (5) reached. Stopping.');
          this.send('chat-stream-token', '\n\n⚠️ 模型输出被截断多次，已停止重试。');
          this.truncationCount = 0;
        } else {
          const reason = isLengthTrunc
            ? 'length'
            : isSoftTrunc
              ? 'soft-stop(mid-sentence)'
              : isEmptyResponse
                ? `empty(${fr || 'no-fr'})`
                : `ambiguous(${fr})`;
          console.warn(`[VercelAgent] Output truncated (${reason}), continuing loop (${this.truncationCount}/5), modelTail=${JSON.stringify(modelTail)}, modelTextChars=${modelTextChars}, finishReason=${finishReason}`);
          // Preserve full conversation context for next iteration:
          // push all messages produced in this run (assistant text, tool-calls, tool-results)
          // so the model sees its prior tool I/O on retry. Fall back to plain-text persistence
          // if for some reason response.messages is empty but fullText is not.
          if (response.messages?.length) {
            for (const msg of response.messages) this.messages.push(msg);
          } else if (fullText.trim()) {
            this.messages.push({ role: 'assistant', content: fullText.trim() });
          }
          // Nudge model based on failure mode
          if (isEmptyResponse) {
            if (hadToolCalls) {
              if (lastStepNumber >= 99) {
                forceNoTools = true;
                console.warn(`[VercelAgent] Empty response after tool calls (lastStep=${lastStepNumber} >= 99). Next run: no tools.`);
                this.send('chat-stream-token', `\n\n⚠️ 工具调用已达步数上限（${lastStepNumber + 1} 步），正在强制生成最终总结…\n`);
                this.messages.push({
                  role: 'user',
                  content:
                    '工具调用已达最大步数限制（100步）。上一轮没有输出任何正文。请基于已有的工具结果直接给出最终中文回答，' +
                    '不要再调用工具，不要任何客套或元说明。',
                });
              } else {
                console.warn(`[VercelAgent] Spontaneous empty stop after tool calls (lastStep=${lastStepNumber} < 99). Nudging to continue.`);
                this.send('chat-stream-token', `\n\n⚠️ 模型遭遇异常中断（第 ${lastStepNumber + 1} 步），正在自动唤醒继续执行…\n`);
                this.messages.push({
                  role: 'user',
                  content:
                    '上一轮回复意外中断（返回了空结果）。如果任务还未完成，请继续你的进度，调用所需工具完成任务；如果任务确已彻底完成，请直接输出最终总结。',
                });
              }
            } else {
              this.messages.push({
                role: 'user',
                content:
                  '上一轮没有输出任何正文。请直接给出最终中文回答，不要任何客套或元说明。',
              });
            }
          } else if (isSoftTrunc || isAmbiguousTrunc) {
            this.messages.push({
              role: 'user',
              content: '继续，从上次中断处无缝接着写到完整句号结尾。不要重复已经说过的内容，不要任何客套或元说明。',
            });
          } else if (isLengthTrunc) {
            this.messages.push({
              role: 'user',
              content: '输出因token长度限制被截断，请接着完成剩余内容，不要重复已经输出的部分。',
            });
          }
          clearTimeout(timeoutId);
          continue; // ← Key: continue the while(true) loop, NOT break
        }
      } else {
        this.truncationCount = 0;
        forceNoTools = false; // Reset on successful output
      }

      // ── Text-based Tool Call Fallback ──
      // If model output text but made no native tool calls, try parsing tools from text
      if (!hadToolCalls && fullText.length > 0) {
        await this.autoExecuteCodeBlocks(fullText);
      }

      // If nothing reached the UI via text-delta (common after tool rounds on some providers),
      // surface tool payloads or a finishReason hint instead of a blank bubble.
      if (!fullText.trim()) {
        const toolTexts =
          (response.messages ?? [])
            ?.filter((m) => m.role === 'tool')
            .map((m) => stringifyStreamValue(m.content))
            .join('\n\n---\n') ?? '';
        if (toolTexts.trim()) {
          const cap = this.getToolResultCapChars();
          const display = toolTexts.length > cap ? `${toolTexts.slice(0, cap)}\n\n...(truncated)` : toolTexts;
          this.send(
            'chat-stream-token',
            `\n\n### 工具输出\n\n\`\`\`tool-output\n${display}\n\`\`\`\n`,
          );
        } else {
          this.send(
            'chat-stream-token',
            `\n\n⚠️ **本轮没有模型正文输出**（finish: **${String(finishReason ?? 'unknown')}**）。若依赖搜索/天气等实时数据，请重试或更换模型。\n`
          );
        }
      }

      // Add response messages to history (handles tool calls + assistant replies properly)
      if (response.messages?.length) {
        for (const msg of response.messages) {
          this.messages.push(msg);
        }
      } else if (fullText.trim()) {
        this.messages.push({ role: 'assistant', content: fullText.trim() });
      }

      // Context window management: sliding window + content truncation
      this.pruneHistory();
      this.retryCount = 0; // Reset retry budget on success
      this.missingToolRecoveryAttempts = 0;
      clearTimeout(timeoutId);
      clearPostToolWatchdog();

    } catch (err: unknown) {
      clearTimeout(timeoutId);
      clearPostToolWatchdog();
      const msg = getErrorMessage(err);
      
      if (err?.name === 'AbortError' || msg === 'Request was aborted.' || msg === 'aborted') {
        if (postToolWatchdogTimedOut) {
          if (fullText.trim()) {
            this.messages.push({ role: 'assistant', content: fullText.trim() });
            this.pruneHistory();
          }
          return;
        }
        // Silently abort instead of printing an error message
        return;
      }
      const deepErrText = this.collectErrorMessages(err);
      console.error('[VercelAgent] ERROR:', msg, deepErrText !== msg ? `(chain: ${deepErrText.slice(0, 400)})` : '');

      // Auth errors → guide user to Settings
      if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('invalid_api_key')) {
        this.send('chat-stream-token', '\n\n⚠️ **认证失败** — API Key 无效或已过期。\n\n请在 Settings (⌘,) 中更新你的 API Key。');
        return;
      }

      // Rate limit → retry via while loop (no recursion)
      if (msg.includes('rate_limit') || msg.includes('429')) {
        this.retryCount = (this.retryCount || 0) + 1;
        if (this.retryCount > 3) {
          this.retryCount = 0;
          this.send('chat-stream-token', '\n\n⚠️ **请求频率超限**，已重试 3 次仍失败。请稍后再试。');
          return;
        }
        const delay = this.retryCount * 5000;
        this.send('chat-stream-token', `\n\n*Rate limited. Retrying in ${delay / 1000}s... (${this.retryCount}/3)*`);
        await new Promise(r => setTimeout(r, delay));
        continue; // True iterative retry via while(true) loop
      }

      // SDK may throw AI_NoOutputGeneratedError while the real reason lives on `cause` (e.g. missing tool results).
      const missingToolRound =
        streamHadMissingToolError ||
        /tool result(?:s)? (?:is|are) missing for tool call/i.test(deepErrText) ||
        /missing for tool call/i.test(deepErrText) ||
        /AI_MissingToolResultsError|MissingToolResultsError/i.test(deepErrText);
      if (missingToolRound) {
        this.missingToolRecoveryAttempts += 1;
        if (this.missingToolRecoveryAttempts <= 2) {
          console.warn(
            `[VercelAgent] Missing tool results — recovery attempt ${this.missingToolRecoveryAttempts}/2`,
          );
          this.send(
            'chat-stream-token',
            `\n\n⚠️ **工具链未闭合**（模型发起了工具调用但流在未收齐结果时结束）。正在自动重试（${this.missingToolRecoveryAttempts}/2）；若仍失败请新开对话或更换模型。\n`,
          );
          // Bidirectional cleanup: strip unpaired tool-calls AND unpaired tool-results.
          // Loop until stable because removing a tool-call can orphan its tool-result,
          // and vice versa (e.g. parallel tool calls where one was answered but the other wasn't).
          let cleanupPasses = 0;
          let prevLen = this.messages.length + 1;
          while (this.messages.length < prevLen && cleanupPasses < 5) {
            prevLen = this.messages.length;
            cleanupPasses++;

            // Collect all tool-call IDs present in assistant messages
            const allToolCallIds = new Set<string>();
            for (const m of this.messages) {
              if (m.role === 'assistant' && Array.isArray(m.content)) {
                for (const p of m.content) {
                  if (p.type === 'tool-call' && p.toolCallId) allToolCallIds.add(p.toolCallId);
                }
              }
            }

            // Collect all tool-result IDs present in tool messages
            const allToolResultIds = new Set<string>();
            for (const m of this.messages) {
              if (m.role === 'tool') {
                const parts = Array.isArray(m.content) ? m.content : [m];
                for (const p of parts) {
                  if (p.toolCallId) allToolResultIds.add(p.toolCallId);
                }
              }
            }

            const cleaned: typeof this.messages = [];
            for (const m of this.messages) {
              if (m.role === 'assistant' && Array.isArray(m.content)) {
                // Strip tool-calls that have no matching tool-result
                const filteredContent = (m.content as ToolCallContentPart[]).filter((p) => {
                  if (p.type === 'tool-call' && p.toolCallId && !allToolResultIds.has(p.toolCallId)) {
                    console.log(`[VercelAgent] Stripping orphaned tool-call: ${p.toolCallId} (${p.toolName})`);
                    return false;
                  }
                  return true;
                });
                if (filteredContent.length > 0) {
                  cleaned.push({ ...m, content: filteredContent });
                }
                // else: assistant message had only orphaned tool-calls → drop entirely
              } else if (m.role === 'tool') {
                // Strip tool-results that have no matching tool-call
                const parts = Array.isArray(m.content) ? m.content : [m];
                const hasMatchingCall = parts.some((p: ToolCallContentPart) => p.toolCallId && allToolCallIds.has(p.toolCallId));
                if (hasMatchingCall) {
                  cleaned.push(m);
                } else {
                  const ids = parts.map((p: ToolCallContentPart) => p.toolCallId).filter(Boolean).join(', ');
                  console.log(`[VercelAgent] Stripping orphaned tool-result: ${ids}`);
                }
              } else {
                cleaned.push(m);
              }
            }
            this.messages = cleaned;
          }
          if (cleanupPasses > 1) {
            console.log(`[VercelAgent] Cleanup required ${cleanupPasses} passes (${prevLen} → ${this.messages.length} messages)`);
          }
          this.messages.push({
            role: 'user',
            content:
              '【系统】请不要再调用任何工具。若你上一轮已看到工具返回的数据，请只用文字总结回答用户；若没有，请如实说明未能完成查询。',
          });
          continue;
        }
        this.send(
          'chat-stream-token',
          '\n\n⚠️ **工具链未闭合**，已自动重试 2 次仍失败。请新开对话或更换模型。\n',
        );
        return;
      }

      // Network errors → friendly message
      if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed') || msg.includes('network')) {
        this.send('chat-stream-token', '\n\n⚠️ **网络连接异常** — 请检查网络连接和代理设置。');
        return;
      }

      // Generic error — avoid duplicating "No output" when we already streamed tool errors + recovery may apply next run
      if (/^no output generated/i.test(msg.trim()) && streamHadMissingToolError) {
        this.send(
          'chat-stream-token',
          '\n\n⚠️ **本轮未正常收尾**（模型未输出正文，常与上方工具链未闭合有关）。若未自动重试成功，请新开对话或换模型。\n',
        );
        return;
      }

      this.send('chat-stream-token', `\n\n⚠️ Error: ${msg.slice(0, 500)}`);
    }
    break; // Exit while(true) on non-retriable errors or success
    } // end while(true)
  }

  /** Flatten `Error.cause` chains so AI_NoOutputGeneratedError can still reveal MissingToolResultsError. */
  private collectErrorMessages(err: unknown, maxDepth = 10): string {
    const parts: string[] = [];
    let e: unknown = err;
    let depth = 0;
    const seen = new Set<unknown>();
    while (e != null && depth++ < maxDepth) {
      if (typeof e === 'object' && e !== null) {
        if (seen.has(e)) break;
        seen.add(e);
        const rec = e as { name?: string; message?: string; cause?: unknown };
        if (typeof rec.name === 'string') parts.push(rec.name);
        if (typeof rec.message === 'string') parts.push(rec.message);
        e = rec.cause;
      } else if (typeof e === 'string') {
        parts.push(e);
        break;
      } else {
        break;
      }
    }
    return parts.join('\n');
  }

  /** Safely extract text content from a message (handles multimodal arrays) */
  private extractTextContent(msg: ModelMessage | undefined): string {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((p): p is { type: 'text'; text: string } => typeof p === 'object' && p !== null && 'type' in p && p.type === 'text')
        .map((p) => p.text || '')
        .join(' ');
    }
    return '';
  }

  /**
   * Text-based Tool Call Fallback Parser
   *
   * When a model doesn't use native function calling, it may embed tool calls
   * in text using various formats. This implements 4 fallback strategies
   * (modeled after cortex engine):
   *
   * 1. Hermes format:  [TOOL_CALLS][{"name": "...", "arguments": {...}}]
   * 2. XML format:     <function=tool_name>{"arg": "val"}</function>
   * 3. JSON code block: ```json {"name": "run_command", "parameters": {...}} ```
   * 4. Bare JSON:      {"name": "run_command", "parameters": {...}}
   *
   * If any are found, they are executed through the normal tool infrastructure.
   */
  private async autoExecuteCodeBlocks(text: string): Promise<void> {
    const toolDefs = this.getTools();
    const availableTools = Object.keys(toolDefs);
    const parsed = parseTextToolCalls(text, availableTools);
    if (parsed.length === 0) return;

    console.log(`[VercelAgent] Fallback: parsed ${parsed.length} tool call(s) from text`);

    for (const tc of parsed) {
      const toolFn = toolDefs[tc.name as keyof typeof toolDefs];
      if (!toolFn) {
        console.warn(`[VercelAgent] Fallback: unknown tool "${tc.name}"`);
        continue;
      }

      this.send('chat-status', `tool:${tc.name}`);
      const argSummary = formatToolArgs(tc.name, tc.args);
      this.send('chat-stream-token', `\n\n> **${tc.name}**${argSummary}\n`);
      console.log(`[VercelAgent] Fallback exec: ${tc.name}`, JSON.stringify(tc.args).slice(0, 200));

      try {
        const result = await (toolFn as { execute: (args: JsonObject, opts: { toolCallId: string }) => Promise<unknown> }).execute(
          tc.args,
          { toolCallId: `fallback-${Date.now()}` },
        );
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        const cap = this.getToolResultCapChars();
        const display = resultStr.length > cap ? resultStr.slice(0, cap) + '\n...(truncated)' : resultStr;
        this.send('chat-stream-token', `\n\`\`\`\n${display}\n\`\`\`\n`);
      } catch (e: unknown) {
        this.send('chat-stream-token', `\n⚠️ Tool error: ${getErrorMessage(e).slice(0, 500)}\n`);
      }
    }
  }
}
