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
import { browsePage } from './browser';
import { webSearch, fetchUrl, isCommandBlocked, buildSystemPromptBase } from './shared-tools';

const execAsync = promisify(exec);

// System prompt: shared base + builtin-specific additions
function getSystemPrompt(cwd: string): string {
  return buildSystemPromptBase(cwd);
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
  { type: 'function', function: { name: 'fetch_url', description: 'Fetch and read content from a URL (static HTML only, no JS rendering).', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browse_page', description: 'Open a URL in a real browser with full JS rendering, then execute a custom script to interact with and extract data from the page. Use for SPAs, dynamic tables, clicking/scrolling. Script runs in page context, can use async/await, MUST return a string.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to open' }, script: { type: 'string', description: 'JavaScript to execute in page context. MUST return a string.' }, wait_before_script: { type: 'number', description: 'Ms to wait after page load. Default: 2000' }, timeout: { type: 'number', description: 'Total timeout ms. Default: 30000' } }, required: ['url', 'script'] } } },
];

// webSearch, fetchUrl, browsePage — all imported from shared modules

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

    console.log(`[BuiltinAgent] Initialized, model=${this.model}, apiKey=${config.apiKey ? config.apiKey.slice(0, 8) + '...' : 'EMPTY'}, baseUrl=${config.baseUrl}`);

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
    const LOOP_TIMEOUT_MS = 90_000; // 90s hard timeout per iteration
    this.abortController = new AbortController();

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      // Hard timeout: auto-abort if LLM hangs
      const timeoutId = setTimeout(() => {
        console.warn('[BuiltinAgent] Loop timeout after 90s — aborting');
        this.abortController?.abort();
      }, LOOP_TIMEOUT_MS);
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
          clearTimeout(timeoutId);
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
        clearTimeout(timeoutId);
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
          // Safety: block catastrophically destructive commands
          const lower = args.command.toLowerCase().replace(/\s+/g, ' ');
          const BANNED = [/rm\s+-rf\s+\/(?!\w)/, /mkfs\./, /dd\s+.*of=\/dev\//, /:(){ :\|:& };:/, />\s*\/dev\/sd[a-z]/];
          if (BANNED.some((re: RegExp) => re.test(lower))) {
            return 'Error: Command blocked for safety.';
          }
          const { stdout, stderr } = await execAsync(args.command, { cwd: this.cwd, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
          this.send('terminal-output', `\r\n$ ${args.command}\r\n${stdout}`);
          return (stdout + (stderr ? `\nSTDERR:\n${stderr}` : '')).slice(0, 16000);
        }
        case 'web_search': return await webSearch(args.query);
        case 'fetch_url': return await fetchUrl(args.url);
        case 'browse_page': return await browsePage({ url: args.url, script: args.script, waitMs: args.wait_before_script ?? 2000, timeoutMs: args.timeout ?? 30000 });
        default: return `Unknown tool: ${name}`;
      }
    } catch (e: any) {
      return `Tool error (${name}): ${e.code === 'ENOENT' ? 'File not found' : e.message}`;
    }
  }
}
