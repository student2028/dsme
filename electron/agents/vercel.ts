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

const execAsync = promisify(exec);

// ── System prompt ───────────────────────────────────────────────────
function getSystemPrompt(cwd: string): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const osInfo = process.platform === 'darwin' ? 'macOS' : process.platform;

  return `You are DSME (DeepSeek Matrix Engine), an autonomous AI coding assistant built for pair programming.
You work inside an Electron-based IDE with full system access. Always prioritize the user's latest request.

## Environment
- OS: ${osInfo}
- Shell: zsh
- Current Time: ${dateStr} ${timeStr} (CRITICAL: Strictly use this time. NEVER fall back to your training cutoff date.)
- Workspace: ${cwd}

## Operating Principles
- Be concise, direct, and action-oriented. Lead with the answer, not the reasoning.
- Respond in the same language as the user.
- Prefer action over description. If a task requires reading, running, or changing something, use tools.
- Never fabricate tool execution or claim you ran something you did not.
- If you can say it in one sentence, don't use three. Skip filler words and preamble.
- For data extraction or list compilation, provide the exhaustive, complete set. Never truncate.

## Tool Usage Rules
- Tool calls are your primary way to interact with the world.
- A text-only response is acceptable ONLY for simple conversation or when prior tool results already answer the question.
- Always read a file before editing it. Prefer minimal, surgical edits.
- If multiple independent tool calls are needed, batch them in parallel.
- Prefer specialized tools over generic shell commands.

### Web Search (CRITICAL — Most Important Tool)
- **AUTO-TRIGGER**: You MUST call web_search automatically whenever:
  - The user asks about current events, news, weather, prices, or any real-time information
  - The query involves dates, times, or anything after your training cutoff
  - You are uncertain about factual claims (people, companies, products, versions)
  - The user asks "what is X" about something that may have changed recently
- **NEVER** say "I don't have access to real-time information" — you DO, via web_search
- **NEVER** say "my knowledge cutoff is..." as an excuse — use web_search instead
- After searching, use fetch_url to read specific pages for detailed information
- Synthesize results from multiple sources into a clear, authoritative answer

### File and Command Discipline
- Use absolute paths for file operations.
- Prefer minimal, surgical edits that preserve existing style.
- Avoid standalone cd; set working directory in the tool call.

## Output Quality
- Treat tool calls as working process; treat the final response as the deliverable.
- Synthesize findings into a clear answer instead of narrating your search trail.
- Report outcomes faithfully. Never claim success unless you actually observed it.
- Use Markdown for readability. Use code fences for code, commands, paths.
- Match structure to the task: simple requests → short answers; complex research → organized sections.

## Language
- Default to 中文 (Chinese) for all responses unless the user writes in another language.
- Match the user's language in conversation.

### replace_in_file — Critical Usage Rules
- ALWAYS read the file first to get exact current content.
- The 'target' parameter must be an EXACT character-for-character match including whitespace, indentation, and newlines.
- Copy-paste from the read_file output to ensure exact match. Never type from memory.
- If a replacement fails with "Target not found", re-read the file and try again with the exact text.

## Safety
- Ask before destructive, irreversible, or externally visible actions.
- Do not modify files outside the workspace unless explicitly asked.
- Never expose API keys, tokens, or credentials.`;
}

// ── Web search via Electron BrowserWindow (real browser, no CAPTCHA) ──
async function webSearch(query: string): Promise<string> {
  if (!query) return 'Error: query is required';
  const q = encodeURIComponent(query);

  // Use a hidden BrowserWindow to load search pages like a real browser
  // This avoids CAPTCHA because it has full browser fingerprint (cookies, JS, etc.)
  const { BrowserWindow: BW } = require('electron');

  async function searchViaWebview(url: string, extractScript: string, label: string): Promise<string | null> {
    return new Promise((resolve) => {
      const searchWin = new BW({
        width: 1024, height: 768,
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });

      const timeout = setTimeout(() => {
        searchWin.destroy();
        resolve(null);
      }, 15000);

      searchWin.webContents.on('did-finish-load', async () => {
        try {
          // Wait a moment for dynamic content to render
          await new Promise(r => setTimeout(r, 1500));
          const result = await searchWin.webContents.executeJavaScript(extractScript);
          clearTimeout(timeout);
          searchWin.destroy();
          if (result && result.trim().length > 20) {
            resolve(`Web search results for "${query}" (${label}):\n${result.trim()}`);
          } else {
            resolve(null);
          }
        } catch {
          clearTimeout(timeout);
          searchWin.destroy();
          resolve(null);
        }
      });

      searchWin.webContents.on('did-fail-load', () => {
        clearTimeout(timeout);
        searchWin.destroy();
        resolve(null);
      });

      searchWin.loadURL(url).catch(() => {
        clearTimeout(timeout);
        searchWin.destroy();
        resolve(null);
      });
    });
  }

  // JS to extract search results from Google
  const googleExtract = `
    (function() {
      var results = [];
      document.querySelectorAll('#search .g, #rso .g').forEach(function(g) {
        var title = g.querySelector('h3');
        var snippet = g.querySelector('.VwiC3b, .IsZvec, [data-sncf], .s3v9rd');
        if (title) {
          var text = title.innerText;
          if (snippet) text += ' — ' + snippet.innerText;
          if (text.length > 10) results.push(text);
        }
      });
      return results.slice(0, 8).join('\\n');
    })()
  `;

  // JS to extract search results from Sogou
  const sogouExtract = `
    (function() {
      var results = [];
      document.querySelectorAll('.vrwrap, .rb').forEach(function(item) {
        var title = item.querySelector('h3, .vrTitle');
        var snippet = item.querySelector('.space-txt, .str-text-info, .str_info, p');
        if (title) {
          var text = title.innerText;
          if (snippet) text += ' — ' + snippet.innerText;
          if (text.length > 10) results.push(text);
        }
      });
      return results.slice(0, 8).join('\\n');
    })()
  `;

  try {
    // Strategy 1: Google (via proxy)
    const googleUrl = `https://www.google.com/search?q=${q}&hl=zh-CN`;
    const googleResult = await searchViaWebview(googleUrl, googleExtract, 'Google');
    if (googleResult) return googleResult;

    // Strategy 2: Sogou (direct, no proxy needed in China)
    const sogouUrl = `https://www.sogou.com/web?query=${q}`;
    const sogouResult = await searchViaWebview(sogouUrl, sogouExtract, 'Sogou');
    if (sogouResult) return sogouResult;

    return `No results found for "${query}". Search engines did not return usable content.`;
  } catch (e: any) {
    return `Search error: ${e.message}`;
  }
}

async function fetchUrl(url: string): Promise<string> {
  if (!url) return 'Error: url is required';
  // Validate URL format to prevent shell injection
  try { const u = new URL(url); if (!['http:', 'https:'].includes(u.protocol)) return 'Error: only http/https URLs supported'; }
  catch { return 'Error: invalid URL'; }
  // Sanitize: remove shell metacharacters
  const safeUrl = url.replace(/[;&|`$(){}!#]/g, '');
  const proxyArgs = process.env.https_proxy ? `--proxy ${process.env.https_proxy}` : '';
  try {
    const cmd = `curl -sS --max-time 20 ${proxyArgs} -L -H "User-Agent: Mozilla/5.0" '${safeUrl}'`;
    const { stdout } = await execAsync(cmd, { timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
    // Strip HTML tags, extract text
    const text = stdout
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 15000);
    return text ? `URL: ${url}\n\n${text}` : `No content from: ${url}`;
  } catch (e: any) {
    return `Fetch error: ${e.message}`;
  }
}

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
    const count = await this.rag.index(this.cwd);
    this.send('rag-status', count);
    return count;
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
        description: 'Fetch and read content from a URL. Returns text extracted from the page.',
        parameters: z.object({ url: z.string().describe('URL to fetch') }),
        execute: async ({ url }) => {
          return await fetchUrl(url);
        },
      }),
    };
  }

  // ── Main stream using Vercel AI SDK streamText ──
  private async runStream(): Promise<void> {
    this.abortController = new AbortController();
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

    } catch (err: any) {
      if (err.name === 'AbortError') return;
      const msg = err?.message || String(err);
      console.error('[VercelAgent] ERROR:', msg);

      // Auth errors → guide user to Settings
      if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('invalid_api_key')) {
        this.send('chat-stream-token', '\n\n⚠️ **认证失败** — API Key 无效或已过期。\n\n请在 Settings (⌘,) 中更新你的 API Key。');
        return;
      }

      // Rate limit → retry with cap
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
        // Iterative retry: re-enter runStream via tail call (non-recursive stack)
        return void await this.runStream();
      }

      // Network errors → friendly message
      if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed') || msg.includes('network')) {
        this.send('chat-stream-token', '\n\n⚠️ **网络连接异常** — 请检查网络连接和代理设置。');
        return;
      }

      // Generic error
      this.send('chat-stream-token', `\n\n⚠️ Error: ${msg.slice(0, 500)}`);
    }
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
