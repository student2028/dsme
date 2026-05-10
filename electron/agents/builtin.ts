/**
 * DSME Built-in Agent — Direct OpenAI-compatible API (no framework dependency)
 *
 * Uses the `openai` npm package directly for:
 * - Streaming text generation via chat.completions.create
 * - Manual tool call loop with iteration guard
 * - Zero framework overhead — lightweight and transparent
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserWindow } from 'electron';
import OpenAI from 'openai';
import type { IAgent, AgentConfig } from './base';
import { RAGEngine } from './rag';

const execAsync = promisify(exec);

// ── System prompt ───────────────────────────────────────────────────
function getSystemPrompt(cwd: string): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const osInfo = process.platform === 'darwin' ? 'macOS' : process.platform;

  return `You are DSME (DeepSeek Matrix Engine), an autonomous AI coding assistant.
You work inside an Electron-based IDE with full system access.

## Environment
- OS: ${osInfo}
- Shell: zsh
- Current Time: ${dateStr} ${timeStr}
- Workspace: ${cwd}

## Tools
Use tools liberally — action over description.
- read_file / write_file / replace_in_file: File operations
- list_directory / search_codebase: Navigation
- run_command: Shell execution
- web_search / fetch_url: Web access

## Rules
- Be concise, direct, action-oriented.
- Respond in the same language as the user.
- Never fabricate tool results.
- For web_search: auto-trigger for weather, news, real-time data.
- NEVER say "I don't have access to real-time information" — use web_search.
- **CRITICAL**: Never create temporary, test, or isolated files directly in the workspace root. ALWAYS place unrelated scripts or generated standalone documents inside a \`scratch/\` folder (create it if missing).`;
}

// ── Tool definitions (OpenAI function calling format) ──
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create/overwrite a file.', parameters: { type: 'object', properties: { filepath: { type: 'string' }, content: { type: 'string' } }, required: ['filepath', 'content'] } } },
  { type: 'function', function: { name: 'replace_in_file', description: 'Replace exact substring in a file.', parameters: { type: 'object', properties: { filepath: { type: 'string' }, target: { type: 'string' }, replacement: { type: 'string' } }, required: ['filepath', 'target', 'replacement'] } } },
  { type: 'function', function: { name: 'list_directory', description: 'List files in a directory.', parameters: { type: 'object', properties: { dirpath: { type: 'string' } }, required: ['dirpath'] } } },
  { type: 'function', function: { name: 'search_codebase', description: 'Grep search across workspace.', parameters: { type: 'object', properties: { query: { type: 'string' }, is_regex: { type: 'boolean' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web for real-time info.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'fetch_url', description: 'Fetch and read content from a URL.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
];

// ── Web search via BrowserWindow ──
async function webSearch(query: string): Promise<string> {
  if (!query) return 'Error: query is required';
  const q = encodeURIComponent(query);
  const { BrowserWindow: BW } = require('electron');

  async function searchVia(url: string, extractJS: string, label: string): Promise<string | null> {
    return new Promise((resolve) => {
      const w = new BW({ width: 1024, height: 768, show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
      const t = setTimeout(() => { w.destroy(); resolve(null); }, 8000);
      w.webContents.on('did-finish-load', async () => {
        try {
          await new Promise(r => setTimeout(r, 1500));
          const r = await w.webContents.executeJavaScript(extractJS);
          clearTimeout(t); w.destroy();
          resolve(r && r.trim().length > 20 ? `Web search (${label}):\n${r.trim()}` : null);
        } catch { clearTimeout(t); w.destroy(); resolve(null); }
      });
      w.webContents.on('did-fail-load', () => { clearTimeout(t); w.destroy(); resolve(null); });
      w.loadURL(url).catch(() => { clearTimeout(t); w.destroy(); resolve(null); });
    });
  }

  const googleJS = `(function(){var r=[];document.querySelectorAll('#search .g, #rso .g').forEach(function(g){var t=g.querySelector('h3');var s=g.querySelector('.VwiC3b, .IsZvec, [data-sncf]');if(t){var x=t.innerText;if(s)x+=' — '+s.innerText;if(x.length>10)r.push(x)}});return r.slice(0,8).join('\\n')})()`;
  const sogouJS = `(function(){var r=[];document.querySelectorAll('.vrwrap, .rb').forEach(function(i){var t=i.querySelector('h3, .vrTitle');var s=i.querySelector('.space-txt, .str-text-info, p');if(t){var x=t.innerText;if(s)x+=' — '+s.innerText;if(x.length>10)r.push(x)}});return r.slice(0,8).join('\\n')})()`;
  const bingJS = `(function(){var r=[];document.querySelectorAll('.b_algo').forEach(function(i){var t=i.querySelector('h2');var s=i.querySelector('.b_caption p, .b_algoSlug, .b_snippet');if(t){var x=t.innerText;if(s)x+=' — '+s.innerText;if(x.length>10)r.push(x)}});return r.slice(0,8).join('\\n')})()`;

  try {
    const promises = [
      searchVia(`https://cn.bing.com/search?q=${q}`, bingJS, 'Bing'),
      searchVia(`https://www.sogou.com/web?query=${q}`, sogouJS, 'Sogou'),
      searchVia(`https://www.google.com/search?q=${q}&hl=zh-CN`, googleJS, 'Google')
    ];

    const firstSuccess = await new Promise<string | null>((resolve) => {
      let count = promises.length;
      for (const p of promises) {
        p.then(res => {
          if (res) resolve(res);
          else if (--count === 0) resolve(null);
        }).catch(() => {
          if (--count === 0) resolve(null);
        });
      }
    });

    if (firstSuccess) return firstSuccess;
    return `No results for "${query}".`;
  } catch (e: any) { return `Search error: ${e.message}`; }
}

// ── Fetch URL ──
async function fetchUrl(url: string): Promise<string> {
  if (!url) return 'Error: url is required';
  try { const u = new URL(url); if (!['http:', 'https:'].includes(u.protocol)) return 'Error: only http/https supported'; }
  catch { return 'Error: invalid URL'; }
  const safeUrl = url.replace(/[;&|`$(){}!#']/g, '');
  const proxy = process.env.https_proxy ? `--proxy ${process.env.https_proxy}` : '';
  try {
    const { stdout } = await execAsync(`curl -sS --max-time 20 ${proxy} -L -H "User-Agent: Mozilla/5.0" "${safeUrl}"`, { timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
    const text = stdout.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 15000);
    return text ? `URL: ${url}\n\n${text}` : `No content from: ${url}`;
  } catch (e: any) { return `Fetch error: ${e.message}`; }
}

// ── Agent implementation ────────────────────────────────────────────
export class BuiltinAgent implements IAgent {
  readonly name = 'Built-in';

  private window!: BrowserWindow;
  private cwd!: string;
  private model!: string;
  private openai!: OpenAI;
  private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  private abortController: AbortController | null = null;
  private busy = false;
  private rag = new RAGEngine();
  private retryCount = 0;
  private fsWatcher: import('fs').FSWatcher | null = null;
  private reindexTimer: ReturnType<typeof setTimeout> | null = null;

  init(window: BrowserWindow, config: AgentConfig): void {
    this.window = window;
    this.cwd = config.cwd;
    this.model = config.model;

    this.openai = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || 'sk-placeholder',
    });

    console.log(`[BuiltinAgent] Initialized, model=${this.model}`);

    // RAG index
    this.rag.index(config.cwd).then(c => {
      console.log(`[BuiltinAgent] RAG indexed ${c} files`);
      this.send('rag-status', c);
    }).catch(() => {});

    this.setupFileWatcher(config.cwd);
  }

  private setupFileWatcher(cwd: string): void {
    try {
      const fsSync = require('fs');
      this.fsWatcher = fsSync.watch(cwd, { recursive: true }, (_: string, filename: string | null) => {
        if (!filename || filename.includes('node_modules') || filename.includes('.git') ||
            filename.includes('dist') || filename.includes('dist-electron')) return;
        if (this.reindexTimer) clearTimeout(this.reindexTimer);
        this.reindexTimer = setTimeout(() => {
          this.rag.index(this.cwd).then(c => this.send('rag-status', c)).catch(() => {});
        }, 5000);
      });
    } catch {}
  }

  private send(channel: string, ...args: any[]) {
    try { this.window.webContents.send(channel, ...args); } catch {}
  }

  async handleMessage(content: string): Promise<void> {
    if (this.busy) { this.abort(); await new Promise(r => setTimeout(r, 500)); }
    this.busy = true;
    this.messages.push({ role: 'user', content });
    this.send('chat-stream-start', '');
    try {
      await this.runLoop();
    } finally {
      this.busy = false;
      this.send('chat-stream-end', '');
      this.send('chat-status', 'idle');
    }
  }

  async handleMessageWithImages(content: string, imageDataUrls: string[]): Promise<void> {
    if (this.busy) { this.abort(); await new Promise(r => setTimeout(r, 500)); }
    this.busy = true;
    const parts: any[] = [{ type: 'text', text: content }];
    for (const dataUrl of imageDataUrls) {
      const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (match) parts.push({ type: 'image_url', image_url: { url: dataUrl } });
    }
    this.messages.push({ role: 'user', content: parts } as any);
    this.send('chat-stream-start', '');
    try { await this.runLoop(); }
    finally { this.busy = false; this.send('chat-stream-end', ''); this.send('chat-status', 'idle'); }
  }

  resetConversation(): void { this.messages = []; this.abort(); this.busy = false; }
  abort(): void { this.abortController?.abort(); this.abortController = null; }
  destroy(): void {
    this.abort();
    if (this.fsWatcher) { this.fsWatcher.close(); this.fsWatcher = null; }
    if (this.reindexTimer) { clearTimeout(this.reindexTimer); this.reindexTimer = null; }
  }
  setupDiffHandlers(): void {
    // Diff handlers managed by VercelAgent; builtin uses the same IPC channels
    // No-op here — main.ts cleans up listeners on kernel switch
  }

  // ── Agent loop: streaming + tool calls ──
  private async runLoop(): Promise<void> {
    const MAX_ITERATIONS = 25;
    this.abortController = new AbortController();

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      try {
        // Build system prompt with RAG context
        const userQuery = this.messages.filter(m => m.role === 'user').pop();
        const queryText = typeof userQuery?.content === 'string' ? userQuery.content : '';
        const systemPrompt = getSystemPrompt(this.cwd) + this.rag.buildContext(queryText);

        const allMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
          { role: 'system', content: systemPrompt },
          ...this.messages,
        ];

        this.send('chat-status', 'thinking');

        // Streaming response
        const stream = await this.openai.chat.completions.create({
          model: this.model,
          messages: allMessages,
          tools: TOOLS,
          tool_choice: 'auto',
          stream: true,
        }, { signal: this.abortController.signal });

        let fullText = '';
        let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        let currentToolIdx = -1;

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          // Text content
          if (delta.content) {
            fullText += delta.content;
            this.send('chat-stream-token', delta.content);
          }

          // Tool calls (streamed incrementally)
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.index !== undefined && tc.index !== currentToolIdx) {
                currentToolIdx = tc.index;
                toolCalls.push({ id: tc.id || '', name: tc.function?.name || '', arguments: '' });
              }
              const current = toolCalls[toolCalls.length - 1];
              if (current) {
                if (tc.id) current.id = tc.id;
                if (tc.function?.name) current.name = tc.function.name;
                if (tc.function?.arguments) current.arguments += tc.function.arguments;
              }
            }
          }
        }

        // Save assistant message
        if (fullText || toolCalls.length > 0) {
          const assistantMsg: any = { role: 'assistant', content: fullText || null };
          if (toolCalls.length > 0) {
            assistantMsg.tool_calls = toolCalls.map(tc => ({
              id: tc.id, type: 'function' as const,
              function: { name: tc.name, arguments: tc.arguments },
            }));
          }
          this.messages.push(assistantMsg);
        }

        // No tool calls → done
        if (toolCalls.length === 0) {
          this.retryCount = 0;
          break;
        }

        // Execute tools
        for (const tc of toolCalls) {
          this.send('chat-status', `tool:${tc.name}`);
          this.send('chat-stream-token', `\n\n> **${tc.name}**\n`);
          console.log(`[BuiltinAgent] Tool: ${tc.name}`);

          let args: any = {};
          try { args = JSON.parse(tc.arguments); } catch {}

          const result = await this.executeTool(tc.name, args);

          this.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result.slice(0, 8000),
          });
        }

        this.send('chat-status', 'thinking');
        // Continue loop for next iteration

      } catch (err: any) {
        if (err.name === 'AbortError') return;
        const msg = err?.message || String(err);
        console.error('[BuiltinAgent] ERROR:', msg);

        if (msg.includes('401') || msg.includes('Unauthorized')) {
          this.send('chat-stream-token', '\n\n⚠️ **认证失败** — 请在 Settings 中更新 API Key。');
          return;
        }
        if (msg.includes('429') || msg.includes('rate_limit')) {
          this.retryCount++;
          if (this.retryCount > 3) { this.retryCount = 0; this.send('chat-stream-token', '\n\n⚠️ 请求超限，请稍后再试。'); return; }
          this.send('chat-stream-token', `\n\n*Rate limited, retrying (${this.retryCount}/3)...*`);
          await new Promise(r => setTimeout(r, this.retryCount * 5000));
          continue;
        }
        if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed')) {
          this.send('chat-stream-token', '\n\n⚠️ **网络连接异常**');
          return;
        }
        this.send('chat-stream-token', `\n\n⚠️ Error: ${msg.slice(0, 500)}`);
        return;
      }
    }

    // Prune history
    if (this.messages.length > 50) {
      this.messages = [...this.messages.slice(0, 2), ...this.messages.slice(-48)];
    }
  }

  // ── Tool execution ──
  private async executeTool(name: string, args: any): Promise<string> {
    const resolve = (p: string) => path.resolve(this.cwd, p);
    try {
      switch (name) {
        case 'read_file': {
          const content = await fs.readFile(resolve(args.filepath), 'utf-8');
          return content.length > 50000 ? content.slice(0, 50000) + '\n...(truncated)' : content;
        }
        case 'write_file': {
          const fp = resolve(args.filepath);
          await fs.mkdir(path.dirname(fp), { recursive: true });
          await fs.writeFile(fp, args.content, 'utf8');
          this.send('file-changed', fp);
          return `Written: ${args.filepath}`;
        }
        case 'replace_in_file': {
          const fp = resolve(args.filepath);
          const old = await fs.readFile(fp, 'utf8');
          if (!old.includes(args.target)) return `Target not found in ${args.filepath}.`;
          await fs.writeFile(fp, old.replace(args.target, args.replacement), 'utf8');
          this.send('file-changed', fp);
          return `Replaced in ${args.filepath}`;
        }
        case 'list_directory': {
          const entries = await fs.readdir(resolve(args.dirpath), { withFileTypes: true });
          return entries.filter(e => !['node_modules', '.git'].includes(e.name))
            .map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`).join('\n');
        }
        case 'search_codebase': {
          const flag = args.is_regex ? '-rnE' : '-rn';
          const safeQ = (args.query as string).replace(/'/g, "'\\''");
          const cmd = `grep ${flag} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist -- '${safeQ}' .`;
          try {
            const { stdout } = await execAsync(cmd, { cwd: this.cwd, maxBuffer: 1024 * 1024 });
            return (stdout || 'No matches.').slice(0, 8000);
          } catch (e: any) { return e.stdout || 'No matches.'; }
        }
        case 'run_command': {
          const { stdout, stderr } = await execAsync(args.command, { cwd: this.cwd, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
          this.send('terminal-output', `\r\n$ ${args.command}\r\n${stdout}`);
          return (stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')).slice(0, 16000);
        }
        case 'web_search': return await webSearch(args.query);
        case 'fetch_url': return await fetchUrl(args.url);
        default: return `Unknown tool: ${name}`;
      }
    } catch (e: any) {
      return `Tool error (${name}): ${e.code === 'ENOENT' ? 'File not found' : e.message}`;
    }
  }
}
