import OpenAI from 'openai';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserWindow } from 'electron';

const execAsync = promisify(exec);

interface AgentConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  cwd: string;
}

const agentTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create/overwrite a file.', parameters: { type: 'object', properties: { filepath: { type: 'string' }, content: { type: 'string' } }, required: ['filepath', 'content'] } } },
  { type: 'function', function: { name: 'replace_in_file', description: 'Replace exact substring in a file.', parameters: { type: 'object', properties: { filepath: { type: 'string' }, target: { type: 'string' }, replacement: { type: 'string' } }, required: ['filepath', 'target', 'replacement'] } } },
  { type: 'function', function: { name: 'list_directory', description: 'List files in a directory.', parameters: { type: 'object', properties: { dirpath: { type: 'string' } }, required: ['dirpath'] } } },
  { type: 'function', function: { name: 'search_codebase', description: 'Grep search across workspace.', parameters: { type: 'object', properties: { query: { type: 'string' }, is_regex: { type: 'boolean' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web for real-time information. Use this when you need current data, news, or anything beyond your training cutoff.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'fetch_url', description: 'Fetch and read content from a URL. Returns text extracted from the page.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to fetch' } }, required: ['url'] } } },
];

function getSystemPrompt(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const timeStr = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const osInfo = process.platform === 'darwin' ? 'macOS' : process.platform;
  const cwd = process.cwd();

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

## Safety
- Ask before destructive, irreversible, or externally visible actions.
- Do not modify files outside the workspace unless explicitly asked.
- Never expose API keys, tokens, or credentials.`;
}

export class DeepSeekAgent {
  private openai: OpenAI;
  private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  private cwd: string;
  private model: string;
  private maxIterations = 25;

  constructor(private window: BrowserWindow, config: AgentConfig) {
    const key = config.apiKey || 'sk-placeholder';
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
    const clientOpts: any = { baseURL: config.baseUrl, apiKey: key, timeout: 60000 };
    if (proxyUrl) {
      try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        clientOpts.httpAgent = new HttpsProxyAgent(proxyUrl);
        console.log('[Agent] Using proxy:', proxyUrl);
      } catch { console.log('[Agent] https-proxy-agent not available, no proxy'); }
    }
    this.openai = new OpenAI(clientOpts);
    this.cwd = config.cwd;
    this.model = config.model;
    this.messages = [{ role: 'system', content: getSystemPrompt() }];

    if (!config.apiKey) {
      this.window.webContents.once('did-finish-load', () => {
        this.window.webContents.send('chat-reply', 'No API key configured. Press Ctrl+, to set up.');
      });
    }
  }

  public async handleUserMessage(content: string) {
    this.messages.push({ role: 'user', content });
    this.send('chat-status', 'thinking');
    this.send('chat-stream-start', null);
    try {
      await this.processLoop(0);
    } catch (e: any) {
      this.send('chat-reply', `\n\nError: ${e?.message || e}`);
    } finally {
      this.send('chat-status', 'idle');
      this.send('chat-stream-end', null);
    }
  }

  public async handleUserMessageWithImages(content: string, imageDataUrls: string[]) {
    // Build multimodal content array for vision models
    const parts: any[] = [];
    if (content) parts.push({ type: 'text', text: content });
    for (const dataUrl of imageDataUrls) {
      parts.push({ type: 'image_url', image_url: { url: dataUrl } });
    }
    this.messages.push({ role: 'user', content: parts } as any);
    this.send('chat-status', 'thinking');
    this.send('chat-stream-start', null);
    try {
      await this.processLoop(0);
    } catch (e: any) {
      this.send('chat-reply', `\n\nError: ${e?.message || e}`);
    } finally {
      this.send('chat-status', 'idle');
      this.send('chat-stream-end', null);
    }
  }

  private send(channel: string, data: any) {
    try { this.window.webContents.send(channel, data); } catch {}
  }

  private async processLoop(iteration: number) {
    if (iteration >= this.maxIterations) {
      this.send('chat-reply', '\n\n*Max iterations reached.*');
      return;
    }

    try {
      // ===== STREAMING =====
      const stream = await this.openai.chat.completions.create({
        model: this.model,
        messages: this.messages,
        tools: agentTools,
        tool_choice: 'auto',
        stream: true,
      });

      let contentBuffer = '';
      let toolCalls: Map<number, { id: string; name: string; args: string }> = new Map();
      let finishReason = '';

      // Stream-start is sent by handleUserMessage, not here (avoids duplicates on recursive calls)

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        finishReason = chunk.choices[0]?.finish_reason || finishReason;

        // Stream text content token by token
        if (delta?.content) {
          contentBuffer += delta.content;
          this.send('chat-stream-token', delta.content);
        }

        // Accumulate tool calls
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCalls.has(idx)) {
              toolCalls.set(idx, { id: tc.id || '', name: tc.function?.name || '', args: '' });
            }
            const entry = toolCalls.get(idx)!;
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
          }
        }
      }

      // NOTE: chat-stream-end is sent by handleUserMessage finally, not here

      // Build the assistant message for history
      const assistantMessage: any = { role: 'assistant', content: contentBuffer || null };
      if (toolCalls.size > 0) {
        assistantMessage.tool_calls = Array.from(toolCalls.values()).map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.args },
        }));
      }
      this.messages.push(assistantMessage);

      // If no tool calls, we're done
      if (toolCalls.size === 0) return;

      // Execute tool calls
      for (const tc of toolCalls.values()) {
        this.send('chat-status', `tool:${tc.name}`);

        let args: any = {};
        try { args = JSON.parse(tc.args); } catch {}

        const argSummary = this.formatToolArgs(tc.name, args);
        this.send('chat-reply', `\n\n> **${tc.name}**${argSummary}`);

        const result = await this.executeTool(tc.name, args);
        this.messages.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, 8000) });
      }

      // Continue loop
      await this.processLoop(iteration + 1);

    } catch (error: any) {
      const msg = error?.message || String(error);
      if (msg.includes('rate_limit') || msg.includes('429')) {
        this.send('chat-reply', '\n\n*Rate limited. Retrying...*');
        await new Promise(r => setTimeout(r, 5000));
        await this.processLoop(iteration);
      } else {
        this.send('chat-reply', `\n\nError: ${msg}`);
      }
    }
  }

  /** Format tool arguments into a human-readable one-liner for display */
  private formatToolArgs(name: string, args: any): string {
    try {
      switch (name) {
        case 'web_search': return args.query ? ` \`${args.query}\`` : '';
        case 'fetch_url': return args.url ? ` \`${args.url.slice(0, 80)}${args.url.length > 80 ? '...' : ''}\`` : '';
        case 'run_command': return args.command ? ` \`${args.command.slice(0, 60)}${args.command.length > 60 ? '...' : ''}\`` : '';
        case 'read_file': return args.filepath ? ` \`${args.filepath}\`` : '';
        case 'write_file': return args.filepath ? ` → \`${args.filepath}\`` : '';
        case 'list_directory': return args.path ? ` \`${args.path}\`` : '';
        default: {
          const keys = Object.keys(args).filter(k => typeof args[k] === 'string');
          if (keys.length > 0) return ` \`${String(args[keys[0]]).slice(0, 60)}\``;
          return '';
        }
      }
    } catch { return ''; }
  }

  private pendingChanges: Map<string, { filepath: string; newContent: string; resolve: (v: string) => void }> = new Map();
  private changeIdCounter = 0;

  public setupDiffHandlers() {
    const { ipcMain } = require('electron');
    ipcMain.on('diff-accept', (_: any, changeId: string) => {
      const pending = this.pendingChanges.get(changeId);
      if (pending) {
        this.pendingChanges.delete(changeId);
        pending.resolve('accepted');
      }
    });
    ipcMain.on('diff-reject', (_: any, changeId: string) => {
      const pending = this.pendingChanges.get(changeId);
      if (pending) {
        this.pendingChanges.delete(changeId);
        pending.resolve('rejected');
      }
    });
  }

  private async executeTool(name: string, args: any): Promise<string> {
    try {
      const resolve = (p: string) => path.resolve(this.cwd, p);

      switch (name) {
        case 'read_file':
          return await fs.readFile(resolve(args.filepath), 'utf8');

        case 'write_file': {
          const fp = resolve(args.filepath);
          await fs.mkdir(path.dirname(fp), { recursive: true });
          // Direct write — no diff preview confirmation
          await fs.writeFile(fp, args.content, 'utf8');
          this.send('file-changed', fp);
          return `Written: ${args.filepath}`;
        }

        case 'replace_in_file': {
          const fp = resolve(args.filepath);
          const oldContent = await fs.readFile(fp, 'utf8');
          if (!oldContent.includes(args.target)) return `Target not found in ${args.filepath}`;
          const newContent = oldContent.replace(args.target, args.replacement);
          // Direct write — no diff preview confirmation
          await fs.writeFile(fp, newContent, 'utf8');
          this.send('file-changed', fp);
          return `Replaced: ${args.filepath}`;
        }

        case 'list_directory': {
          const entries = await fs.readdir(resolve(args.dirpath), { withFileTypes: true });
          return entries.filter(e => !['node_modules', '.git'].includes(e.name))
            .map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`).join('\n');
        }

        case 'search_codebase': {
          const flag = args.is_regex ? '-rnE' : '-rn';
          const cmd = `grep ${flag} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist "${args.query}" .`;
          try { return (await execAsync(cmd, { cwd: this.cwd, maxBuffer: 1024 * 1024 })).stdout || 'No matches.'; }
          catch (e: any) { return e.stdout || 'No matches.'; }
        }

        case 'run_command': {
          const { stdout, stderr } = await execAsync(args.command, { cwd: this.cwd, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
          this.send('terminal-output', `\r\n$ ${args.command}\r\n${stdout}`);
          return stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
        }

        case 'web_search': {
          const query = args.query || '';
          if (!query) return 'Error: query is required';
          this.send('chat-status', 'tool:searching web...');
          const q = encodeURIComponent(query);
          const { execSync } = require('child_process');
          const all: any[] = [];

          // curl-based search (fast, reliable, no Electron SSL issues)
          const curlSearch = (searchUrl: string, regex: RegExp, engineName: string) => {
            try {
              const html = execSync(
                `curl -sS --connect-timeout 10 --max-time 15 "${searchUrl}" -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" 2>/dev/null`,
                { encoding: 'utf8', timeout: 20000 }
              );
              let match;
              while ((match = regex.exec(html)) && all.length < 8) {
                const [, url, title, snippet] = match;
                if (url && title) all.push({ engine: engineName, title: title.replace(/<[^>]*>/g, '').trim(), url: url.trim(), snippet: (snippet || '').replace(/<[^>]*>/g, '').trim() });
              }
              console.log(`[web_search] ${engineName}: ${all.length} results`);
            } catch (e: any) { console.log(`[web_search] ${engineName} failed: ${e.message}`); }
          };

          // DuckDuckGo HTML (no JS needed)
          curlSearch(
            `https://html.duckduckgo.com/html/?q=${q}`,
            /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi,
            'DuckDuckGo'
          );

          // Bing as backup
          if (all.length < 3) {
            curlSearch(
              `https://cn.bing.com/search?q=${q}&setlang=zh-Hans`,
              /<li class="b_algo"[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<p[^>]*>(.*?)<\/p>/gi,
              'Bing'
            );
          }

          const engines = [...new Set(all.map(r => r.engine))].join('+');
          if (!all.length) return `No search results found for: ${query}`;
          return `Search results for "${query}" [${engines}]:\n\n` +
            all.slice(0, 10).map((r, i) => `[${i+1}] ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
        }

        case 'fetch_url': {
          const url = args.url || '';
          if (!url) return 'Error: url is required';
          this.send('chat-status', 'tool:fetching...');

          try {
            const { execSync } = require('child_process');
            const safeUrl = url.replace(/"/g, '\\"');
            const html = execSync(
              `curl -sS -L --connect-timeout 10 --max-time 20 "${safeUrl}" -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" 2>/dev/null | head -c 200000`,
              { encoding: 'utf8', timeout: 25000 }
            );
            // Extract title
            const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
            const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';
            // Strip HTML to text
            const text = html
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<(header|footer|nav|aside)[\s\S]*?<\/\1>/gi, '')
              .replace(/<[^>]*>/g, ' ')
              .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
              .replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n')
              .trim();
            const content = text.slice(0, 15000);
            return `Title: ${title}\nURL: ${url}\n\n${content}`;
          } catch (e: any) { return `Fetch error: ${e.message}`; }
        }

        default: return `Unknown tool: ${name}`;
      }
    } catch (err: any) { return `Tool error (${name}): ${err.message}`; }
  }
}

