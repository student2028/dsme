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
import {
  deriveHistoryBudgetTokens,
  deriveNonUserContentCapChars,
  deriveToolResultCapChars,
  estimateMessagesTokens,
} from './token-config';
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
} from './browser-use';
import {
  formatWebSearchResult,
  hasUsableSearchResults,
  webSearch,
  fetchUrl,
  searchCodebase,
  isCommandBlocked,
  buildSystemPromptBase,
} from './shared-tools';

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
  { type: 'function', function: { name: 'browser_task_start', description: 'Start a named multi-step browser session so all following browser_* steps appear under one timeline heading in the UI. Call once per complex browser workflow.', parameters: { type: 'object', properties: { goal: { type: 'string', description: 'Short user-visible goal, e.g. "Export CSV from dashboard"' } }, required: ['goal'] } } },
  { type: 'function', function: { name: 'browser_task_finish', description: 'End the browser session started with browser_task_start. Optionally provide a short summary for the browser panel banner.', parameters: { type: 'object', properties: { summary: { type: 'string', description: 'Outcome summary (optional)' } } } } },
  { type: 'function', function: { name: 'browser_navigate', description: 'Navigate the visible built-in browser to a URL. Prefer browser_task_start(goal) before long flows.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browser_snapshot', description: 'Capture page text layout with element refs [e1],[e2]… Call before click/type.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_click', description: 'Click element by ref from browser_snapshot.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } } },
  { type: 'function', function: { name: 'browser_type', description: 'Type into input/textarea by ref from browser_snapshot.', parameters: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['ref', 'text'] } } },
  { type: 'function', function: { name: 'browser_scroll', description: 'Scroll the page up or down.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] } }, required: ['direction'] } } },
  { type: 'function', function: { name: 'browser_back', description: 'Browser history back.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_eval', description: 'Run arbitrary JS in page context; must return a string.', parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] } } },
];

// webSearch, fetchUrl, browsePage — all imported from shared modules

// ── Agent implementation ────────────────────────────────────────────
export class BuiltinAgent implements IAgent {
  readonly name = 'Built-in';

  private window!: BrowserWindow;
  private cwd!: string;
  private model!: string;
  private maxOutputTokens!: number;
  private maxContextTokens!: number;
  private openai!: OpenAI;
  private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  private abortController: AbortController | null = null;
  private busy = false;
  private rag = new RAGEngine();
  private retryCount = 0;
  private truncationCount = 0;
  private fsWatcher: import('fs').FSWatcher | null = null;
  private reindexTimer: ReturnType<typeof setTimeout> | null = null;
  private currentTurnSearchResult: { query: string; result: string } | null = null;

  init(window: BrowserWindow, config: AgentConfig): void {
    this.window = window;
    this.cwd = config.cwd;
    this.model = config.model;
    this.maxOutputTokens = config.maxOutputTokens;
    this.maxContextTokens = config.maxContextTokens;

    this.openai = new OpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || 'sk-placeholder',
    });

    console.log(`[BuiltinAgent] Initialized, model=${this.model}, apiKey=${config.apiKey ? config.apiKey.slice(0, 8) + '...' : 'EMPTY'}, baseUrl=${config.baseUrl}, maxOutputTokens=${this.maxOutputTokens}, maxContextTokens=${this.maxContextTokens}`);

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
          this.rag.update().then(({ added, updated, removed }) => {
            if (added > 0 || updated > 0 || removed > 0) {
              this.send('rag-status', this.rag.fileCount);
            }
          }).catch(() => {});
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
    this.currentTurnSearchResult = null;

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      this.pruneHistory();
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
          max_completion_tokens: this.maxOutputTokens,
        }, { signal: this.abortController.signal });

        let fullText = '';
        let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        let currentToolIdx = -1;
        let finishReason = '';
        let insideThink = false;
        let thinkBuffer = '';

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (chunk.choices[0]?.finish_reason) finishReason = chunk.choices[0].finish_reason;
          if (!delta) continue;

          // Text content — with <think> tag collapsible rendering
          if (delta.content) {
            const raw = delta.content;
            if (insideThink) {
              thinkBuffer += raw;
              const endIdx = thinkBuffer.indexOf('</think>');
              if (endIdx !== -1) {
                insideThink = false;
                const thinkContent = thinkBuffer.slice(0, endIdx);
                const afterThink = thinkBuffer.slice(endIdx + 8);
                thinkBuffer = '';
                const collapsed = `\n<details>\n<summary>💭 思考过程</summary>\n\n${thinkContent.trim()}\n\n</details>\n`;
                fullText += collapsed;
                this.send('chat-stream-token', collapsed);
                if (afterThink) { fullText += afterThink; this.send('chat-stream-token', afterThink); }
              }
            } else {
              const thinkIdx = raw.indexOf('<think>');
              if (thinkIdx !== -1) {
                const before = raw.slice(0, thinkIdx);
                if (before) { fullText += before; this.send('chat-stream-token', before); }
                insideThink = true;
                thinkBuffer = raw.slice(thinkIdx + 7);
                const endIdx = thinkBuffer.indexOf('</think>');
                if (endIdx !== -1) {
                  insideThink = false;
                  const thinkContent = thinkBuffer.slice(0, endIdx);
                  const afterThink = thinkBuffer.slice(endIdx + 8);
                  thinkBuffer = '';
                  const collapsed = `\n<details>\n<summary>💭 思考过程</summary>\n\n${thinkContent.trim()}\n\n</details>\n`;
                  fullText += collapsed;
                  this.send('chat-stream-token', collapsed);
                  if (afterThink) { fullText += afterThink; this.send('chat-stream-token', afterThink); }
                }
              } else {
                fullText += raw;
                this.send('chat-stream-token', raw);
              }
            }
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

        // No tool calls → check for truncation, then fallback parsing
        if (toolCalls.length === 0) {
          // Handle output truncation (finish_reason='length'):
          // Continue the loop so model can resume generating
          if (finishReason === 'length') {
            this.truncationCount++;
            if (this.truncationCount >= 5) {
              console.error('[BuiltinAgent] Max consecutive truncations (5). Stopping.');
              this.send('chat-stream-token', '\n\n⚠️ 模型输出被截断多次，已停止重试。');
              this.truncationCount = 0;
            } else {
              console.warn(`[BuiltinAgent] Output truncated, continuing loop (${this.truncationCount}/5)`);
              clearTimeout(timeoutId);
              continue; // ← continue, NOT break
            }
          } else {
            this.truncationCount = 0;
          }

          if (fullText.length > 0) {
            await this.autoExecuteCodeBlocks(fullText);
          }
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

          const visibleCap = this.getToolResultCapChars();
          const preview =
            result.length > visibleCap ? `${result.slice(0, visibleCap)}\n...(truncated)` : result;
          this.send(
            'chat-stream-token',
            `\n\n### 工具输出 (${tc.name})\n\n\`\`\`tool-output\n${preview}\n\`\`\`\n`,
          );

          this.messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: this.clipToolResult(result),
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

    this.pruneHistory();
  }

  private pruneHistory(): void {
    const maxContentLen = deriveNonUserContentCapChars(this.maxContextTokens);
    const maxHistoryTokens = deriveHistoryBudgetTokens(this.maxContextTokens);

    if (this.messages.length > 50) {
      this.messages = [...this.messages.slice(0, 2), ...this.messages.slice(-48)];
    }

    for (const msg of this.messages) {
      if (typeof msg.content === 'string' && msg.content.length > maxContentLen && msg.role !== 'user') {
        msg.content = msg.content.slice(0, maxContentLen) + '\n...(truncated for context)';
      }
    }

    while (this.messages.length > 12 && estimateMessagesTokens(this.messages) > maxHistoryTokens) {
      this.messages.shift();
    }
  }

  private getToolResultCapChars(): number {
    return deriveToolResultCapChars(this.maxContextTokens);
  }

  private clipToolResult(result: string): string {
    const cap = this.getToolResultCapChars();
    return result.length > cap ? result.slice(0, cap) + '\n...(truncated for context)' : result;
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
          return await searchCodebase(args.query, this.cwd, args.is_regex);
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
        case 'web_search': {
          if (this.currentTurnSearchResult && hasUsableSearchResults(this.currentTurnSearchResult.result)) {
            const reused = [
              `Skipped duplicate web_search for "${args.query}".`,
              `A usable search result already exists in this turn from query "${this.currentTurnSearchResult.query}".`,
              'Use the previous snippets to answer now.',
              '',
              this.currentTurnSearchResult.result,
            ].join('\n');
            this.send('chat-stream-token', `\n已拦截重复浏览器搜索：${args.query}\n`);
            return formatWebSearchResult(args.query, reused);
          }
          this.send('chat-stream-token', `\n正在用浏览器搜索：${args.query}\n`);
          const started = Date.now();
          const rawResult = await webSearch(args.query);
          const result = formatWebSearchResult(args.query, rawResult);
          if (hasUsableSearchResults(rawResult)) {
            this.currentTurnSearchResult = { query: args.query, result: rawResult };
          }
          const seconds = ((Date.now() - started) / 1000).toFixed(1);
          const preview = rawResult.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 5).join('\n');
          this.send(
            'chat-stream-token',
            preview
              ? `\n搜索解析完成（${seconds}s），已提取到：\n\`\`\`search-snippet\n${preview}\n\`\`\`\n`
              : `\n搜索完成（${seconds}s），但没有提取到可用摘要。\n`,
          );
          return result;
        }
        case 'fetch_url': return await fetchUrl(args.url);
        case 'browse_page': {
          this.send('chat-stream-token', `\n正在打开浏览器页面：${args.url}\n`);
          const started = Date.now();
          const result = await browsePage({ url: args.url, script: args.script, waitMs: args.wait_before_script ?? 2000, timeoutMs: args.timeout ?? 30000 });
          const seconds = ((Date.now() - started) / 1000).toFixed(1);
          this.send('chat-stream-token', `\n页面解析完成（${seconds}s）：${result.slice(0, 500)}${result.length > 500 ? '\n...(truncated)' : ''}\n`);
          return result;
        }
        case 'browser_task_start': {
          this.send('chat-stream-token', `\n🌐 浏览器长任务开始：${args.goal}\n`);
          return await browserTaskStart(args.goal);
        }
        case 'browser_task_finish': {
          const summary = args.summary ? String(args.summary) : '';
          this.send(
            'chat-stream-token',
            summary ? `\n🌐 浏览器任务结束：${summary}\n` : `\n🌐 浏览器任务结束。\n`,
          );
          return await browserTaskFinish(summary || undefined);
        }
        case 'browser_navigate': {
          this.send('chat-stream-token', `\n浏览器导航 → ${args.url}\n`);
          return await browserNavigate(args.url);
        }
        case 'browser_snapshot': return await browserSnapshot();
        case 'browser_click': {
          this.send('chat-stream-token', `\n浏览器点击 ${args.ref}\n`);
          return await browserClick(args.ref);
        }
        case 'browser_type': {
          this.send('chat-stream-token', `\n浏览器输入 ${args.ref}\n`);
          return await browserType(args.ref, args.text);
        }
        case 'browser_scroll': return await browserScroll(args.direction);
        case 'browser_back': return await browserBack();
        case 'browser_eval': {
          this.send('chat-stream-token', `\n浏览器执行脚本…\n`);
          return await browserEval(args.script);
        }
        default: return `Unknown tool: ${name}`;
      }
    } catch (e: any) {
      return `Tool error (${name}): ${e.code === 'ENOENT' ? 'File not found' : e.message}`;
    }
  }

  /** Text-based tool call fallback (Hermes / XML / JSON code block / bare JSON) */
  private async autoExecuteCodeBlocks(text: string): Promise<void> {
    const availableTools = TOOLS.map(t => t.function.name);
    const parsed = this.parseTextToolCalls(text, availableTools);
    if (parsed.length === 0) return;

    console.log(`[BuiltinAgent] Fallback: parsed ${parsed.length} tool call(s) from text`);

    for (const tc of parsed) {
      this.send('chat-status', `tool:${tc.name}`);
      this.send('chat-stream-token', `\n\n> **${tc.name}**\n`);
      console.log(`[BuiltinAgent] Fallback exec: ${tc.name}`);

      try {
        const result = await this.executeTool(tc.name, tc.args);
        const cap = this.getToolResultCapChars();
        const display = result.length > cap ? result.slice(0, cap) + '\n...(truncated)' : result;
        this.send('chat-stream-token', `\n\`\`\`\n${display}\n\`\`\`\n`);
      } catch (e: any) {
        this.send('chat-stream-token', `\n⚠️ Tool error: ${e.message?.slice(0, 500)}\n`);
      }
    }
  }

  private parseTextToolCalls(text: string, availableTools: string[]): { name: string; args: any }[] {
    // Strategy 1: Hermes
    const hermesMatch = text.match(/\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/);
    if (hermesMatch) {
      try {
        const calls = JSON.parse(hermesMatch[1]);
        if (Array.isArray(calls)) {
          return calls.filter((c: any) => c.name && availableTools.includes(c.name))
            .map((c: any) => ({ name: c.name, args: c.arguments || c.parameters || {} }));
        }
      } catch {}
    }
    // Strategy 2: XML
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
    // Strategy 3: JSON code blocks
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
    // Strategy 4: Bare JSON
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

    // Strategy 5: Raw code blocks → synthesize write_file + run_command
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
      const ext = lang === 'python' || lang === 'py' ? '.py' :
                  lang === 'javascript' || lang === 'js' ? '.js' :
                  lang === 'typescript' || lang === 'ts' ? '.ts' : '.sh';
      const filename = `scratch/auto_${Date.now()}${ext}`;
      codeCalls.push({ name: 'write_file', args: { filepath: filename, content: code } });
      codeCalls.push({ name: 'run_command', args: { command: `${runner} ${filename}` } });
    }
    if (codeCalls.length > 0) return codeCalls;

    return [];
  }
}
