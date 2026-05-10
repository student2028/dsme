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
import { webSearch, fetchUrl, buildSystemPromptBase } from './shared-tools';

const execAsync = promisify(exec);

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
  private apiKey = '';
  private provider!: ReturnType<typeof createOpenAI>;
  private messages: Array<{ role: string; content: string }> = [];
  private abortController: AbortController | null = null;
  private pendingChanges = new Map<string, { filepath: string; newContent: string; resolve: (v: string) => void }>();
  private changeIdCounter = 0;
  private retryCount = 0;
  private busy = false;
  private rag = new RAGEngine();

  init(window: BrowserWindow, config: AgentConfig): void {
    this.window = window;
    this.cwd = config.cwd;
    this.model = config.model;
    this.apiKey = config.apiKey || '';

    // Create OpenAI-compatible provider via Vercel AI SDK
    this.provider = createOpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || 'sk-placeholder',
      compatibility: 'compatible', // For non-OpenAI providers like DeepSeek/SiliconFlow
    });

    console.log(`[VercelAgent] Initialized with Vercel AI SDK, model=${this.model}, baseUrl=${config.baseUrl}`);

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
      this.send('chat-stream-token', '⚠️ **API Key 未配置**\n\n请在 Settings (⌘,) 中配置你的 API Key，然后重试。\n\n支持的服务商：SiliconFlow、OpenAI、DeepSeek 等 OpenAI-compatible 接口。');
      this.send('chat-stream-end', '');
      this.send('chat-status', 'idle');
      return;
    }
    this.busy = true;
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

  resetConversation(): void { this.messages = []; this.abort(); this.busy = false; }
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
    const MAX_CONTENT_LEN = 3000; // per-message content cap
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
      if (typeof msg.content === 'string' && msg.content.length > MAX_CONTENT_LEN && msg.role !== 'user') {
        msg.content = msg.content.slice(0, MAX_CONTENT_LEN) + '\n...(truncated for context)';
      }
    }
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
        parameters: z.object({ filepath: z.string() }),
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
        parameters: z.object({ filepath: z.string(), content: z.string() }),
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
        parameters: z.object({ filepath: z.string(), target: z.string(), replacement: z.string() }),
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
        parameters: z.object({ dirpath: z.string() }),
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
        parameters: z.object({ query: z.string(), is_regex: z.boolean().optional() }),
        execute: async ({ query, is_regex }) => {
          const flag = is_regex ? '-rnE' : '-rn';
          // Escape query for shell safety (use -- to prevent flag injection)
          const safeQuery = query.replace(/'/g, "'\\''");
          const cmd = `grep ${flag} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist -- '${safeQuery}' .`;
          try {
            const result = (await execAsync(cmd, { cwd, maxBuffer: 1024 * 1024 })).stdout || 'No matches.';
            return result.length > 8000 ? result.slice(0, 8000) + `\n...(truncated)` : result;
          }
          catch (e: any) { return e.stdout || 'No matches.'; }
        },
      }),

      run_command: tool({
        description: 'Run shell command.',
        parameters: z.object({ command: z.string() }),
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
        parameters: z.object({ query: z.string().describe('Search query') }),
        execute: async ({ query }) => {
          return await webSearch(query);
        },
      }),

      fetch_url: tool({
        description: 'Fetch and read content from a URL. Returns text extracted from the page. Does NOT execute JavaScript — for JS-rendered pages, use browse_page instead.',
        parameters: z.object({ url: z.string().describe('URL to fetch') }),
        execute: async ({ url }) => {
          return await fetchUrl(url);
        },
      }),

      browse_page: tool({
        description: 'Open a URL in a real browser with full JavaScript rendering, then execute a custom script to interact with and extract data from the page. Use this for: (1) JS-rendered SPAs (React/Vue/dynamic tables), (2) pages requiring clicks/scrolls/form fills, (3) data extraction from complex layouts. The script runs in page context with full DOM access and can use async/await. It MUST return a string.',
        parameters: z.object({
          url: z.string().describe('URL to open'),
          script: z.string().describe('JavaScript to execute in page context. Can use async/await for multi-step interactions (click → wait → extract). MUST return a string.'),
          wait_before_script: z.number().optional().describe('Milliseconds to wait after page loads before running script. Default: 2000. Increase for slow-loading pages.'),
          timeout: z.number().optional().describe('Total timeout in milliseconds. Default: 30000.'),
        }),
        execute: async ({ url, script, wait_before_script, timeout }) => {
          return await browsePage({ url, script, waitMs: wait_before_script ?? 2000, timeoutMs: timeout ?? 30000 });
        },
      }),
    };
  }

  // ── Main stream using Vercel AI SDK streamText ──
  private async runStream(): Promise<void> {
    const STREAM_TIMEOUT_MS = 90_000; // 90s hard timeout per attempt
    // True iterative retry loop (no recursion, no stack growth)
    while (true) {
    this.abortController = new AbortController();
    // Hard timeout: auto-abort if LLM hangs
    const timeoutId = setTimeout(() => {
      console.warn('[VercelAgent] Stream timeout after 90s — aborting');
      this.abortController?.abort();
    }, STREAM_TIMEOUT_MS);
    try {
      const result = streamText({
        model: this.provider.chat(this.model),
        system: getSystemPrompt(this.cwd) + this.rag.buildContext(
          // Use last user message as RAG query (safely handle multimodal content)
          this.extractTextContent(this.messages.filter(m => m.role === 'user').pop())
        ),
        messages: this.messages as any,
        tools: this.getTools(),
        stopWhen: stepCountIs(25),
        abortSignal: this.abortController.signal,

        // Lifecycle callbacks for UI updates
        onStepFinish: ({ stepNumber, text, toolCalls, toolResults }) => {
          console.log(`[VercelAgent] Step ${stepNumber} finished: text=${text?.length || 0}ch, tools=${toolCalls?.length || 0}`);
        },

        experimental_onToolCallStart: ({ toolName, input }) => {
          console.log(`[VercelAgent] Tool start: ${toolName}`, JSON.stringify(input).slice(0, 200));
          this.send('chat-status', `tool:${toolName}`);
          const argSummary = formatToolArgs(toolName, input);
          this.send('chat-stream-token', `\n\n> **${toolName}**${argSummary}\n`);
        },

        experimental_onToolCallFinish: ({ toolName, durationMs, error }) => {
          if (error) {
            console.error(`[VercelAgent] Tool ${toolName} failed after ${durationMs}ms:`, error);
          } else {
            console.log(`[VercelAgent] Tool ${toolName} done in ${durationMs}ms`);
          }
          this.send('chat-status', 'thinking');
        },
      });

      // Consume the full stream (text + tool events)
      let fullText = '';
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            fullText += (part as any).text ?? '';
            this.send('chat-stream-token', (part as any).text ?? '');
            break;
          case 'error':
            console.error('[VercelAgent] Stream error:', (part as any).error);
            break;
        }
      }

      // Get final response messages for conversation history
      const response = await result.response;
      console.log(`[VercelAgent] Stream complete: text=${fullText.length}ch`);

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
      clearTimeout(timeoutId);

    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') return;
      const msg = err?.message || String(err);
      console.error('[VercelAgent] ERROR:', msg);

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

      // Network errors → friendly message
      if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed') || msg.includes('network')) {
        this.send('chat-stream-token', '\n\n⚠️ **网络连接异常** — 请检查网络连接和代理设置。');
        return;
      }

      // Generic error
      this.send('chat-stream-token', `\n\n⚠️ Error: ${msg.slice(0, 500)}`);
    }
    break; // Exit while(true) on non-retriable errors or success
    } // end while(true)
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
}
