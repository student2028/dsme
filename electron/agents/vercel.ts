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

## Safety
- Ask before destructive, irreversible, or externally visible actions.
- Do not modify files outside the workspace unless explicitly asked.
- Never expose API keys, tokens, or credentials.`;
}

// ── Web search via curl (robust, bypasses Electron network stack) ──
async function webSearch(query: string): Promise<string> {
  if (!query) return 'Error: query is required';
  const q = encodeURIComponent(query);
  const proxyArgs = process.env.https_proxy ? ['--proxy', process.env.https_proxy] : [];

  try {
    // Use DuckDuckGo HTML for search (no JS needed)
    const cmd = `curl -sS --max-time 15 ${proxyArgs.join(' ')} -H "User-Agent: Mozilla/5.0" "https://html.duckduckgo.com/html/?q=${q}" | grep -oP 'class="result__a"[^>]*href="[^"]*"[^>]*>[^<]*' | head -8`;
    const { stdout } = await execAsync(cmd, { timeout: 20000, maxBuffer: 1024 * 1024 });

    if (!stdout.trim()) {
      // Fallback: Google via curl
      const cmd2 = `curl -sS --max-time 15 ${proxyArgs.join(' ')} -H "User-Agent: Mozilla/5.0" "https://www.google.com/search?q=${q}&hl=zh-CN" | grep -oP '<h3[^>]*>[^<]+</h3>' | head -6`;
      const { stdout: s2 } = await execAsync(cmd2, { timeout: 20000, maxBuffer: 1024 * 1024 });
      if (s2.trim()) return `Search results for "${query}":\n${s2}`;
      return `No results found for: ${query}`;
    }
    return `Search results for "${query}":\n${stdout}`;
  } catch (e: any) {
    return `Search error: ${e.message}`;
  }
}

async function fetchUrl(url: string): Promise<string> {
  if (!url) return 'Error: url is required';
  const proxyArgs = process.env.https_proxy ? ['--proxy', process.env.https_proxy] : [];
  try {
    const cmd = `curl -sS --max-time 20 ${proxyArgs.join(' ')} -L -H "User-Agent: Mozilla/5.0" "${url}"`;
    const { stdout } = await execAsync(cmd, { timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
    // Strip HTML tags, extract text
    const text = stdout
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 15000);
    return `URL: ${url}\n\n${text}`;
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
      case 'list_directory': return args.dirpath ? ` \`${args.dirpath}\`` : '';
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
  private provider!: ReturnType<typeof createOpenAI>;
  private messages: Array<{ role: string; content: string }> = [];
  private abortController: AbortController | null = null;
  private pendingChanges = new Map<string, { filepath: string; newContent: string; resolve: (v: string) => void }>();
  private changeIdCounter = 0;
  private busy = false;

  init(window: BrowserWindow, config: AgentConfig): void {
    this.window = window;
    this.cwd = config.cwd;
    this.model = config.model;

    // Create OpenAI-compatible provider via Vercel AI SDK
    this.provider = createOpenAI({
      baseURL: config.baseUrl,
      apiKey: config.apiKey || 'sk-placeholder',
      compatibility: 'compatible', // For non-OpenAI providers like DeepSeek/SiliconFlow
    });

    console.log(`[VercelAgent] Initialized with Vercel AI SDK, model=${this.model}, baseUrl=${config.baseUrl}`);
  }

  private send(channel: string, ...args: any[]) {
    try { this.window.webContents.send(channel, ...args); } catch {}
  }

  async handleMessage(content: string): Promise<void> {
    if (this.busy) {
      this.abort();
      await new Promise(r => setTimeout(r, 500));
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
    this.busy = true;
    this.messages.push({ role: 'user', content: `${content}\n\n[Images attached: ${imageDataUrls.length}]` });
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
          const content = await fs.readFile(resolve(filepath), 'utf-8');
          if (content.length > 50000) {
            return content.slice(0, 50000) + `\n\n...(truncated, ${content.length} total chars)`;
          }
          return content;
        },
      }),

      write_file: tool({
        description: 'Create/overwrite a file.',
        parameters: z.object({ filepath: z.string(), content: z.string() }),
        execute: async ({ filepath, content }) => {
          const fp = resolve(filepath);
          await fs.mkdir(path.dirname(fp), { recursive: true });
          await fs.writeFile(fp, content, 'utf8');
          send('file-changed', fp);
          return `Written: ${filepath}`;
        },
      }),

      replace_in_file: tool({
        description: 'Replace exact substring in a file.',
        parameters: z.object({ filepath: z.string(), target: z.string(), replacement: z.string() }),
        execute: async ({ filepath, target, replacement }) => {
          const fp = resolve(filepath);
          const old = await fs.readFile(fp, 'utf8');
          if (!old.includes(target)) return `Target not found in ${filepath}`;
          await fs.writeFile(fp, old.replace(target, replacement), 'utf8');
          send('file-changed', fp);
          return `Replaced in ${filepath}`;
        },
      }),

      list_directory: tool({
        description: 'List files in a directory.',
        parameters: z.object({ dirpath: z.string() }),
        execute: async ({ dirpath }) => {
          const entries = await fs.readdir(resolve(dirpath), { withFileTypes: true });
          return entries.filter(e => !['node_modules', '.git'].includes(e.name))
            .map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`).join('\n');
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
          const { stdout, stderr } = await execAsync(command, { cwd, timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
          send('terminal-output', `\r\n$ ${command}\r\n${stdout}`);
          return stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
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
        system: getSystemPrompt(this.cwd),
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

    } catch (err: any) {
      if (err.name === 'AbortError') return;
      const msg = err?.message || String(err);
      console.error('[VercelAgent] ERROR:', msg);

      if (msg.includes('rate_limit') || msg.includes('429')) {
        this.send('chat-stream-token', '\n\n*Rate limited. Retrying in 5s...*');
        await new Promise(r => setTimeout(r, 5000));
        return this.runStream();
      }

      this.send('chat-stream-token', `\n\nError: ${msg}`);
    }
  }
}
