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
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserWindow, ipcMain } from 'electron';
import { streamText, tool, stepCountIs } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import type { IAgent, AgentConfig } from './base';
import { RAGEngine } from './rag';
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
  searchCodebase,
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
} from './browser-use';

const execAsync = promisify(exec);

/** Model-specific fenced blocks — slice offsets MUST match full delimiter length (historically caused leaked tags / stray text). */
const REDACTED_THINK_OPEN = '<think>';
const REDACTED_THINK_CLOSE = '</think>';

// System prompt: shared base (from shared-tools.ts)
function getSystemPrompt(cwd: string): string {
  return buildSystemPromptBase(cwd);
}

// webSearch, fetchUrl — imported from shared-tools.ts
// browsePage — imported from ./browser

// ── Format tool args for display ──
function formatToolArgs(name: string, args: any): string {
  try {
    switch (name) {
      case 'web_search': return args.query ? ` \`${args.query}\`` : '';
      case 'fetch_url': return args.url ? ` \`${args.url.slice(0, 80)}${args.url.length > 80 ? '...' : ''}\`` : '';
      case 'run_command': return args.command ? ` \`${args.command.slice(0, 60)}${args.command.length > 60 ? '...' : ''}\`` : '';
      case 'read_file': return args.filepath ? ` \`${args.filepath}\`` : '';
      case 'write_file': return args.filepath ? ` → \`${args.filepath}\`` : '';
      case 'replace_in_file': return args.filepath ? ` \`${args.filepath}\`` : '';
      case 'list_directory': return args.dirpath ? ` \`${args.dirpath}\`` : '';
      case 'search_codebase': return args.query ? ` \`${args.query.slice(0, 40)}${args.query.length > 40 ? '...' : ''}\`` : '';
      case 'browse_page': return args.url ? ` \`${args.url.slice(0, 60)}${args.url.length > 60 ? '...' : ''}\`` : '';
      case 'browser_navigate': return args.url ? ` → \`${args.url.slice(0, 60)}\`` : '';
      case 'browser_snapshot': return ' 📸';
      case 'browser_click': return args.ref ? ` [${args.ref}]` : '';
      case 'browser_type': return args.ref ? ` [${args.ref}] "${(args.text || '').slice(0, 20)}"` : '';
      case 'browser_scroll': return args.direction ? ` ${args.direction}` : '';
      case 'browser_back': return ' ←';
      case 'browser_eval': return args.script ? ` \`${args.script.slice(0, 40)}...\`` : '';
      case 'browser_press_key': return args.key ? ` ⌨️ ${args.key}` : '';
      case 'browser_list_frames': return ' 🖼️';
      case 'browser_switch_frame': return args.frameIndex !== undefined ? ` → frame[${args.frameIndex}]` : '';
      case 'browser_task_start': return args.goal ? ` — ${args.goal.slice(0, 80)}${args.goal.length > 80 ? '…' : ''}` : '';
      case 'browser_task_finish':
        return args.summary
          ? ` — ${args.summary.slice(0, 240)}${args.summary.length > 240 ? '…' : ''}`
          : '';
      // Electron Native tools
      case 'browser_find': return args.text ? ` 🔍 "${args.text}"` : '';
      case 'browser_stop_find': return ' 🔍 clear';
      case 'browser_export_cookies': return ' 🍪 export';
      case 'browser_import_cookies': return args.file_path ? ` 🍪 import ${args.file_path}` : ' 🍪 import';
      case 'browser_clear_session': return ' 🧹';
      case 'browser_zoom': return args.factor ? ` 🔎 ${Math.round(args.factor * 100)}%` : '';
      case 'browser_export_pdf': return ' 📄 PDF';
      case 'browser_read_clipboard': return ' 📋 read';
      case 'browser_write_clipboard': return ' 📋 write';
      case 'browser_page_health': return ' 🩺';
      case 'browser_show_overlay': return ' 🔵 X-ray';
      case 'browser_clear_overlay': return ' clear';
      case 'browser_highlight_ref': return args.ref ? ` 🟠 [${args.ref}]` : '';
      case 'browser_upload_file': return args.ref ? ` 📁 [${args.ref}]` : '';
      case 'browser_capture_network': return args.url_pattern ? ` 🌐 "${args.url_pattern}"` : '';
      default: return '';
    }
  } catch { return ''; }
}

// ── Agent implementation using Vercel AI SDK ────────────────────────
export class VercelAgent implements IAgent {
  readonly name = 'Vercel AI SDK';

  private window!: BrowserWindow;
  private cwd!: string;
  private model!: string;
  private maxOutputTokens!: number;
  private maxContextTokens!: number;
  private apiKey = '';
  private provider!: ReturnType<typeof createOpenAI>;
  private messages: Array<{ role: string; content: string }> = [];
  private abortController: AbortController | null = null;
  private pendingChanges = new Map<string, { filepath: string; newContent: string; resolve: (v: string) => void }>();
  private changeIdCounter = 0;
  private retryCount = 0;
  /** Retries when the provider ends the stream without pairing tool calls to results (MissingToolResults / similar). */
  private missingToolRecoveryAttempts = 0;
  private truncationCount = 0;
  private busy = false;
  private rag = new RAGEngine();
  private currentTurnSearchResult: { query: string; result: string } | null = null;

  init(window: BrowserWindow, config: AgentConfig): void {
    this.window = window;
    this.cwd = config.cwd;
    this.model = config.model;
    this.maxOutputTokens = config.maxOutputTokens;
    this.maxContextTokens = config.maxContextTokens;
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
      } catch {}
      return line;
    };

    this.provider = createOpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || 'sk-placeholder',
      compatibility: 'compatible',
      fetch: async (url, init) => {
        const response = await globalThis.fetch(url, init);
        if (!response.body) return response;
        const originalBody = response.body;
        const transform = new TransformStream({
          _buffer: '',
          transform(chunk, controller) {
            const text = new TextDecoder().decode(chunk);
            (this as any)._buffer += text;
            const lines = (this as any)._buffer.split('\n');
            (this as any)._buffer = lines.pop()!;
            for (const line of lines) {
              controller.enqueue(new TextEncoder().encode(patchSSELine(line) + '\n'));
            }
          },
          flush(controller) {
            if ((this as any)._buffer?.trim()) {
              controller.enqueue(new TextEncoder().encode(patchSSELine((this as any)._buffer) + '\n'));
            }
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

    // Index project files for RAG (non-blocking)
    this.rag.index(config.cwd).then(count => {
      console.log(`[VercelAgent] RAG indexed ${count} files`);
      this.send('rag-status', count);
    }).catch(() => {});

    // Watch for file changes → auto re-index RAG (debounced)
    this.setupFileWatcher(config.cwd);
  }

  private reindexTimer: ReturnType<typeof setTimeout> | null = null;
  private fsWatcher: import('fs').FSWatcher | null = null;

  private setupFileWatcher(cwd: string): void {
    try {
      const fsSync = require('fs');
      this.fsWatcher = fsSync.watch(cwd, { recursive: true }, (_event: string, filename: string | null) => {
        if (!filename) return;
        // Ignore non-code directories
        if (filename.includes('node_modules') || filename.includes('.git') || 
            filename.includes('dist') || filename.includes('dist-electron')) return;
        // Debounce: wait 5s after last change before re-indexing
        if (this.reindexTimer) clearTimeout(this.reindexTimer);
        this.reindexTimer = setTimeout(() => {
          console.log(`[RAG] File change detected (${filename}), re-indexing...`);
          this.reindex().catch(() => {});
        }, 5000);
      });
      console.log(`[RAG] File watcher active on ${cwd}`);
    } catch (e) {
      console.log(`[RAG] File watcher unavailable:`, (e as Error).message);
    }
  }

  getRagFileCount(): number { return this.rag.fileCount; }

  async reindex(): Promise<number> {
    // Use incremental update (mtime-based) instead of full rebuild
    const { added, updated, removed } = await this.rag.update();
    if (added > 0 || updated > 0 || removed > 0) {
      this.send('rag-status', this.rag.fileCount);
    }
    return this.rag.fileCount;
  }

  private send(channel: string, ...args: any[]) {
    try { this.window.webContents.send(channel, ...args); } catch {}
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
    const parts: any[] = [{ type: 'text', text: content }];
    for (const dataUrl of imageDataUrls) {
      // dataUrl format: "data:image/png;base64,iVBOR..."
      const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) {
        parts.push({ type: 'image', image: match[2], mimeType: match[1] });
      }
    }
    this.messages.push({ role: 'user', content: parts } as any);
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

  loadHistory(history: any[]): void {
    if (this.busy) this.abort();
    this.messages = history.map(m => {
      // Reconstruct image attachments
      if (m.role === 'user' && m.attachments && m.attachments.some((a: any) => a.type === 'image' && a.dataUrl)) {
        const imageParts = m.attachments
          .filter((a: any) => a.type === 'image' && a.dataUrl)
          .map((a: any) => ({
            type: 'image' as const,
            image: new URL(a.dataUrl)
          }));
        
        return {
          role: 'user',
          content: [
            { type: 'text' as const, text: m.content },
            ...imageParts
          ]
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  abort(): void { this.abortController?.abort(); this.abortController = null; }

  /** Clean up resources (file watcher, timers) before disposal */
  destroy(): void {
    this.abort();
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
      console.log('[VercelAgent] File watcher closed');
    }
    if (this.reindexTimer) {
      clearTimeout(this.reindexTimer);
      this.reindexTimer = null;
    }
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
        if ((m as any).role === 'assistant' && Array.isArray((m as any).content)) {
          for (const p of (m as any).content) {
            if (p.type === 'tool-call' && p.toolCallId) allToolCallIds.add(p.toolCallId);
          }
        }
      }

      // Collect all tool-result IDs from tool messages
      const allToolResultIds = new Set<string>();
      for (const m of this.messages) {
        if ((m as any).role === 'tool') {
          const parts = Array.isArray((m as any).content) ? (m as any).content : [m];
          for (const p of parts) {
            if (p.toolCallId) allToolResultIds.add(p.toolCallId);
          }
        }
      }

      const cleaned: typeof this.messages = [];
      for (const m of this.messages) {
        if ((m as any).role === 'assistant' && Array.isArray((m as any).content)) {
          // Strip tool-calls that have no matching tool-result
          const filteredContent = ((m as any).content as any[]).filter((p: any) => {
            if (p.type === 'tool-call' && p.toolCallId && !allToolResultIds.has(p.toolCallId)) {
              console.log(`[VercelAgent] pruneHistory: stripping orphaned tool-call ${p.toolCallId} (${p.toolName})`);
              return false;
            }
            return true;
          });
          if (filteredContent.length > 0) {
            cleaned.push({ ...(m as any), content: filteredContent });
          }
          // else: assistant message had only orphaned tool-calls → drop entirely
        } else if ((m as any).role === 'tool') {
          // Strip tool-results that have no matching tool-call
          const parts = Array.isArray((m as any).content) ? (m as any).content : [m];
          const hasMatchingCall = parts.some((p: any) => p.toolCallId && allToolCallIds.has(p.toolCallId));
          if (hasMatchingCall) {
            cleaned.push(m);
          } else {
            const ids = parts.map((p: any) => p.toolCallId).filter(Boolean).join(', ');
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

  setupDiffHandlers(): void {
    ipcMain.on('diff-accept', (_e, changeId: string) => {
      const p = this.pendingChanges.get(changeId);
      if (p) { this.pendingChanges.delete(changeId); p.resolve('accepted'); }
    });
    ipcMain.on('diff-reject', (_e, changeId: string) => {
      const p = this.pendingChanges.get(changeId);
      if (p) { this.pendingChanges.delete(changeId); p.resolve('rejected'); }
    });
  }

  // ── Build Vercel AI SDK tools ──
  private getTools() {
    const cwd = this.cwd;
    const send = this.send.bind(this);
    const resolve = (p: string) => path.resolve(cwd, p);

    return {
      read_file: tool({
        description: 'Read a file.',
        inputSchema: z.object({ filepath: z.string() }),
        execute: async ({ filepath }) => {
          try {
            const content = await fs.readFile(resolve(filepath), 'utf-8');
            if (content.length > 50000) {
              return content.slice(0, 50000) + `\n\n...(truncated, ${content.length} total chars)`;
            }
            return content;
          } catch (e: any) {
            return `Error reading ${filepath}: ${e.code === 'ENOENT' ? 'File not found' : e.message}`;
          }
        },
      }),

      write_file: tool({
        description: 'Create/overwrite a file.',
        inputSchema: z.object({ filepath: z.string(), content: z.string() }),
        execute: async ({ filepath, content }) => {
          try {
            const fp = resolve(filepath);
            await fs.mkdir(path.dirname(fp), { recursive: true });
            await fs.writeFile(fp, content, 'utf8');
            send('file-changed', fp);
            return `Written: ${filepath}`;
          } catch (e: any) {
            return `Error writing ${filepath}: ${e.message}`;
          }
        },
      }),

      replace_in_file: tool({
        description: 'Replace exact substring in a file. Replaces the first occurrence.',
        inputSchema: z.object({ filepath: z.string(), target: z.string(), replacement: z.string() }),
        execute: async ({ filepath, target, replacement }) => {
          try {
            const fp = resolve(filepath);
            const old = await fs.readFile(fp, 'utf8');
            if (!old.includes(target)) return `Target not found in ${filepath}. Verify exact whitespace/indentation.`;
            const occurrences = old.split(target).length - 1;
            await fs.writeFile(fp, old.replace(target, replacement), 'utf8');
            send('file-changed', fp);
            return `Replaced in ${filepath}` + (occurrences > 1 ? ` (1 of ${occurrences} occurrences)` : '');
          } catch (e: any) {
            return `Error editing ${filepath}: ${e.code === 'ENOENT' ? 'File not found' : e.message}`;
          }
        },
      }),

      list_directory: tool({
        description: 'List files in a directory.',
        inputSchema: z.object({ dirpath: z.string() }),
        execute: async ({ dirpath }) => {
          try {
            const entries = await fs.readdir(resolve(dirpath), { withFileTypes: true });
            return entries.filter(e => !['node_modules', '.git'].includes(e.name))
              .map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`).join('\n');
          } catch (e: any) {
            return `Error listing ${dirpath}: ${e.code === 'ENOENT' ? 'Directory not found' : e.message}`;
          }
        },
      }),

      search_codebase: tool({
        description: 'Grep search across workspace.',
        inputSchema: z.object({ query: z.string(), is_regex: z.boolean().optional() }),
        execute: async ({ query, is_regex }) => {
          return await searchCodebase(query, cwd, is_regex);
        },
      }),

      run_command: tool({
        description: 'Run shell command.',
        inputSchema: z.object({ command: z.string() }),
        execute: async ({ command }) => {
          // Safety: block catastrophically destructive commands
          const lower = command.toLowerCase().replace(/\s+/g, ' ');
          const BANNED = [
            /rm\s+-rf\s+\/(?!\w)/,     // rm -rf / (but allow /some/path)
            /mkfs\./,                   // format filesystem
            /dd\s+.*of=\/dev\//,        // disk overwrite
            /:(){ :\|:& };:/,           // fork bomb
            />\s*\/dev\/sd[a-z]/,       // raw disk write
          ];
          if (BANNED.some(re => re.test(lower))) {
            return 'Error: Command blocked for safety. This command could cause catastrophic data loss.';
          }
          try {
            const { stdout, stderr } = await execAsync(command, { cwd, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
            send('terminal-output', `\r\n$ ${command}\r\n${stdout}`);
            let result = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
            return result.length > 16000 ? result.slice(0, 16000) + '\n...(truncated)' : result;
          } catch (e: any) {
            const out = (e.stdout || '') + (e.stderr ? `\nSTDERR:\n${e.stderr}` : '');
            send('terminal-output', `\r\n$ ${command}\r\n${out || e.message}`);
            return out || `Command failed: ${e.message}`;
          }
        },
      }),

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
        execute: async ({ url }) => browserNavigate(url),
      }),

      browser_snapshot: tool({
        description: 'Get a text snapshot of the current page with interactive element references [e1], [e2], etc. Use this to see what is on the page and find elements to interact with. Always call this BEFORE clicking or typing. The snapshot will show a ⚠️ PAGE STATE: LOADING warning if the page is still processing — if you see this, call browser_wait_for_idle before interacting.',
        inputSchema: z.object({}),
        execute: async () => browserSnapshot(),
      }),

      browser_click: tool({
        description: 'Click an element by its reference ID from browser_snapshot. Example: ref="e3" clicks the third interactive element. Auto-waits for page idle after click. If the result says [DISABLED], the element is not clickable yet — wait and retry.',
        inputSchema: z.object({ ref: z.string().describe('Element reference from snapshot, e.g. "e3"') }),
        execute: async ({ ref }) => browserClick(ref),
      }),

      browser_type: tool({
        description: 'Type text into an input/textarea element by its reference ID. Clears existing content first.',
        inputSchema: z.object({
          ref: z.string().describe('Element reference from snapshot'),
          text: z.string().describe('Text to type'),
        }),
        execute: async ({ ref, text }) => browserType(ref, text),
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
        execute: async ({ timeout_ms }) => browserWaitForIdle(timeout_ms),
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
        execute: async ({ frameIndex }) => browserSwitchFrame(frameIndex),
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

      render_html: tool({
        description: 'Render a beautiful, rich HTML document directly in the IDE browser panel. Use this for highly visual results like shopping items, social media posts, image galleries, or dashboards. You can use absolute local file paths (e.g. file:///Users/...) directly in src/href attributes.',
        inputSchema: z.object({ html: z.string().describe('The complete HTML document string to render (include <style> tags or Tailwind via CDN for styling).') }),
        execute: async ({ html }) => {
          const { browserViewManager } = require('../browser-view-manager');
          const { BrowserWindow } = require('electron');
          const allWindows = BrowserWindow.getAllWindows();
          const mainWindow = allWindows.find((w: any) => w.getTitle()?.includes('DSME')) || allWindows[0];
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
        system: getSystemPrompt(this.cwd) + this.rag.buildContext(
          // Use last user message as RAG query (safely handle multimodal content)
          this.extractTextContent(this.messages.filter(m => m.role === 'user').pop())
        ),
        messages: this.messages as any,
        tools: forceNoTools ? undefined : this.getTools(),
        maxOutputTokens: this.maxOutputTokens,
        stopWhen: stepCountIs(100),
        abortSignal: this.abortController.signal,

        // Lifecycle callbacks for UI updates
        onStepFinish: ({ stepNumber, text, toolCalls, toolResults }) => {
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
            const rawDelta = (part as any).text ?? (part as any).textDelta;
            let delta = rawDelta == null ? '' : typeof rawDelta === 'string' ? rawDelta : String(rawDelta);
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
            const toolCallId = (part as any).toolCallId ?? (part as any).id;
            const toolName = (part as any).toolName;
            if (toolCallId && toolName) toolCallNames.set(toolCallId, toolName);
            sawToolCallPart = true;
            lastEventWasText = false;
            break;
          }
          case 'error': {
            const e = (part as any).error;
            const msg = typeof e?.message === 'string' ? e.message : String(e ?? 'stream error');
            const ename = typeof (e as any)?.name === 'string' ? (e as any).name : '';
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
            const e = (part as any).error ?? part;
            const msg = typeof e === 'string' ? e : e?.message ?? JSON.stringify(e);
            console.error('[VercelAgent] Tool stream error:', e);
            this.send('chat-stream-token', `\n\n⚠️ **工具错误** — ${String(msg).slice(0, 800)}\n`);
            break;
          }
          case 'tool-result':
          case 'tool-output-available':
          case 'tool-output-error':
          case 'tool-output-denied': {
            const toolCallId = (part as any).toolCallId ?? (part as any).id;
            const toolName = (part as any).toolName ?? (toolCallId ? toolCallNames.get(toolCallId) : undefined);
            const visible = visibleTextFromStreamPart({ ...(part as any), toolName }, this.getToolResultCapChars());
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
      const hadToolCalls = (response.messages ?? []).some((m: any) => {
        if (m.role !== 'assistant') return false;
        const c = m.content;
        if (Array.isArray(c)) return c.some((p: any) => p?.type === 'tool-call');
        return false;
      });
      // Robust signal: did the stream end while the model was emitting final text
      // (rather than tool-call args)? Combine message-shape check with live event tracking.
      const lastAssistantMsg = [...(response.messages ?? [])].reverse().find((m: any) => m.role === 'assistant');
      const lastMsgHasToolCall = Array.isArray(lastAssistantMsg?.content) &&
        (lastAssistantMsg!.content as any[]).some((p: any) => p?.type === 'tool-call');
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
            for (const msg of response.messages) this.messages.push(msg as any);
          } else if (fullText.trim()) {
            this.messages.push({ role: 'assistant', content: fullText.trim() });
          }
          // Nudge model based on failure mode
          if (isEmptyResponse) {
            // When model was doing tool calls but produced no text, force next run to be text-only.
            // This handles step-limit exhaustion (stepCountIs triggered mid-tool-loop) and
            // spontaneous empty stops after tool rounds.
            if (hadToolCalls) {
              forceNoTools = true;
              console.warn(`[VercelAgent] Empty response after tool calls (lastStep=${lastStepNumber}). Next run: no tools.`);
              this.send('chat-stream-token', `\n\n⚠️ 工具调用已达步数上限（${lastStepNumber + 1} 步），正在生成最终总结…\n`);
            }
            this.messages.push({
              role: 'user',
              content:
                '上一轮没有输出任何正文。请基于已有的工具结果（如果有）直接给出最终中文回答，' +
                '不要再调用工具，不要任何客套或元说明。',
            });
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
          (response.messages as any[])
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
          this.messages.push(msg as any);
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

    } catch (err: any) {
      clearTimeout(timeoutId);
      clearPostToolWatchdog();
      const msg = err?.message || String(err);
      
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
              if ((m as any).role === 'assistant' && Array.isArray((m as any).content)) {
                for (const p of (m as any).content) {
                  if (p.type === 'tool-call' && p.toolCallId) allToolCallIds.add(p.toolCallId);
                }
              }
            }

            // Collect all tool-result IDs present in tool messages
            const allToolResultIds = new Set<string>();
            for (const m of this.messages) {
              if ((m as any).role === 'tool') {
                const parts = Array.isArray((m as any).content) ? (m as any).content : [m];
                for (const p of parts) {
                  if (p.toolCallId) allToolResultIds.add(p.toolCallId);
                }
              }
            }

            const cleaned: typeof this.messages = [];
            for (const m of this.messages) {
              if ((m as any).role === 'assistant' && Array.isArray((m as any).content)) {
                // Strip tool-calls that have no matching tool-result
                const filteredContent = ((m as any).content as any[]).filter((p: any) => {
                  if (p.type === 'tool-call' && p.toolCallId && !allToolResultIds.has(p.toolCallId)) {
                    console.log(`[VercelAgent] Stripping orphaned tool-call: ${p.toolCallId} (${p.toolName})`);
                    return false;
                  }
                  return true;
                });
                if (filteredContent.length > 0) {
                  cleaned.push({ ...(m as any), content: filteredContent });
                }
                // else: assistant message had only orphaned tool-calls → drop entirely
              } else if ((m as any).role === 'tool') {
                // Strip tool-results that have no matching tool-call
                const parts = Array.isArray((m as any).content) ? (m as any).content : [m];
                const hasMatchingCall = parts.some((p: any) => p.toolCallId && allToolCallIds.has(p.toolCallId));
                if (hasMatchingCall) {
                  cleaned.push(m);
                } else {
                  const ids = parts.map((p: any) => p.toolCallId).filter(Boolean).join(', ');
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
    let e: any = err;
    let depth = 0;
    const seen = new Set<unknown>();
    while (e != null && depth++ < maxDepth) {
      if (typeof e === 'object' && e !== null) {
        if (seen.has(e)) break;
        seen.add(e);
      }
      if (typeof e?.name === 'string') parts.push(e.name);
      if (typeof e?.message === 'string') parts.push(e.message);
      else if (typeof e === 'string') parts.push(e);
      e = e?.cause;
    }
    return parts.join('\n');
  }

  /** Safely extract text content from a message (handles multimodal arrays) */
  private extractTextContent(msg: { role: string; content: any } | undefined): string {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text || '')
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
    const parsed = this.parseTextToolCalls(text, availableTools);
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
        const result = await (toolFn as any).execute(tc.args, { toolCallId: `fallback-${Date.now()}` });
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        const cap = this.getToolResultCapChars();
        const display = resultStr.length > cap ? resultStr.slice(0, cap) + '\n...(truncated)' : resultStr;
        this.send('chat-stream-token', `\n\`\`\`\n${display}\n\`\`\`\n`);
      } catch (e: any) {
        this.send('chat-stream-token', `\n⚠️ Tool error: ${e.message?.slice(0, 500)}\n`);
      }
    }
  }

  /** Parse tool calls from text using multiple fallback formats. */
  private parseTextToolCalls(text: string, availableTools: string[]): { name: string; args: any }[] {
    // Strategy 1: Hermes — [TOOL_CALLS][{"name": "...", "arguments": {...}}]
    const hermesMatch = text.match(/\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/);
    if (hermesMatch) {
      try {
        const calls = JSON.parse(hermesMatch[1]);
        if (Array.isArray(calls)) {
          return calls
            .filter((c: any) => c.name && availableTools.includes(c.name))
            .map((c: any) => ({ name: c.name, args: c.arguments || c.parameters || {} }));
        }
      } catch {}
    }

    // Strategy 2: XML — <function=tool_name>{"arg": "val"}</function>
    const xmlRegex = /<function=([^>]+)>([\s\S]*?)<\/function>/g;
    const xmlCalls: { name: string; args: any }[] = [];
    let xmlMatch;
    while ((xmlMatch = xmlRegex.exec(text)) !== null) {
      const name = xmlMatch[1].trim();
      if (!availableTools.includes(name)) continue;
      try { xmlCalls.push({ name, args: JSON.parse(xmlMatch[2].trim()) }); }
      catch { xmlCalls.push({ name, args: {} }); }
    }
    if (xmlCalls.length > 0) return xmlCalls;

    // Strategy 3: JSON code blocks — ```json\n{"name": "tool", "parameters": {...}}\n```
    const jsonBlockRegex = /```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?```/g;
    const jsonCalls: { name: string; args: any }[] = [];
    let jsonMatch;
    while ((jsonMatch = jsonBlockRegex.exec(text)) !== null) {
      try {
        const data = JSON.parse(jsonMatch[1]);
        if (data.name && availableTools.includes(data.name)) {
          jsonCalls.push({ name: data.name, args: data.parameters || data.arguments || {} });
        }
      } catch {}
    }
    if (jsonCalls.length > 0) return jsonCalls;

    // Strategy 4: Bare JSON — {"name": "tool", "parameters": {...}}
    const bareRegex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"(?:parameters|arguments)"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
    const bareCalls: { name: string; args: any }[] = [];
    let bareMatch;
    while ((bareMatch = bareRegex.exec(text)) !== null) {
      const name = bareMatch[1];
      if (!availableTools.includes(name)) continue;
      try { bareCalls.push({ name, args: JSON.parse(bareMatch[2]) }); }
      catch {}
    }
    if (bareCalls.length > 0) return bareCalls;

    // Strategy 5: Raw code blocks — ```python\ncode\n``` or ```bash\ncode\n```
    // Last resort: if model just outputs raw code blocks, extract and wrap as
    // write_file + run_command tool calls
    const codeBlockRegex = /```(\w+)\n([\s\S]*?)```/g;
    const codeCalls: { name: string; args: any }[] = [];
    let codeMatch;
    const RUNNABLE: Record<string, string> = {
      python: 'python3', py: 'python3',
      javascript: 'node', js: 'node',
      typescript: 'npx tsx', ts: 'npx tsx',
      bash: 'bash', sh: 'bash', zsh: 'zsh',
    };
    while ((codeMatch = codeBlockRegex.exec(text)) !== null) {
      const lang = codeMatch[1].toLowerCase();
      const code = codeMatch[2].trim();
      const runner = RUNNABLE[lang];
      if (!runner || code.length < 10) continue;
      // Synthesize write_file + run_command
      const ext = lang === 'python' || lang === 'py' ? '.py' :
                  lang === 'javascript' || lang === 'js' ? '.js' :
                  lang === 'typescript' || lang === 'ts' ? '.ts' : '.sh';
      const filename = `scratch/auto_${Date.now()}${ext}`;
      codeCalls.push({ name: 'write_file', args: { filepath: filename, content: code } });
      codeCalls.push({ name: 'run_command', args: { command: `${runner} ${filename}` } });
    }
    if (codeCalls.length > 0) {
      console.log(`[VercelAgent] Strategy 5: Synthesized ${codeCalls.length} tool calls from raw code blocks`);
      return codeCalls;
    }

    return [];
  }
}
