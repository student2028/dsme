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
];

const SYSTEM_PROMPT = `You are Antigravity, a world-class autonomous AI coding agent. You operate inside an Electron IDE with full system access.

Tools: read_file, write_file, replace_in_file, list_directory, search_codebase, run_command

Principles:
1. BE AUTONOMOUS — don't ask, just do
2. THINK step by step — plan then execute
3. VERIFY — read files back after editing
4. HANDLE ERRORS — diagnose and retry
5. Use Markdown. Be concise but complete.`;

export class DeepSeekAgent {
  private openai: OpenAI;
  private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  private cwd: string;
  private model: string;
  private maxIterations = 25;

  constructor(private window: BrowserWindow, config: AgentConfig) {
    const key = config.apiKey || 'sk-placeholder';
    this.openai = new OpenAI({ baseURL: config.baseUrl, apiKey: key });
    this.cwd = config.cwd;
    this.model = config.model;
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];

    if (!config.apiKey) {
      this.window.webContents.once('did-finish-load', () => {
        this.window.webContents.send('chat-reply', '⚠️ No API key. Press Ctrl+, to configure.');
      });
    }
  }

  public async handleUserMessage(content: string) {
    this.messages.push({ role: 'user', content });
    this.send('chat-status', 'thinking');
    await this.processLoop(0);
    this.send('chat-status', 'idle');
  }

  private send(channel: string, data: any) {
    try { this.window.webContents.send(channel, data); } catch {}
  }

  private async processLoop(iteration: number) {
    if (iteration >= this.maxIterations) {
      this.send('chat-reply', '\n\n⚠️ Max iterations reached.');
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

      // Signal new assistant message start
      this.send('chat-stream-start', null);

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

      // Signal stream end
      this.send('chat-stream-end', null);

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
        this.send('chat-reply', `\n\n> 🔧 ${tc.name}`);
        this.send('chat-status', `tool:${tc.name}`);

        let args: any = {};
        try { args = JSON.parse(tc.args); } catch {}

        const result = await this.executeTool(tc.name, args);
        this.messages.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, 8000) });
      }

      // Continue loop
      await this.processLoop(iteration + 1);

    } catch (error: any) {
      const msg = error?.message || String(error);
      if (msg.includes('rate_limit') || msg.includes('429')) {
        this.send('chat-reply', '\n\n⏳ Rate limited. Retrying...');
        await new Promise(r => setTimeout(r, 5000));
        await this.processLoop(iteration);
      } else {
        this.send('chat-reply', `\n\n❌ Error: ${msg}`);
      }
    }
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
          await fs.writeFile(fp, args.content, 'utf8');
          this.send('file-changed', fp);
          return `✅ Written: ${args.filepath}`;
        }

        case 'replace_in_file': {
          const fp = resolve(args.filepath);
          let c = await fs.readFile(fp, 'utf8');
          if (!c.includes(args.target)) return `❌ Target not found in ${args.filepath}`;
          c = c.replace(args.target, args.replacement);
          await fs.writeFile(fp, c, 'utf8');
          this.send('file-changed', fp);
          return `✅ Replaced in: ${args.filepath}`;
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

        default: return `Unknown tool: ${name}`;
      }
    } catch (err: any) { return `Tool error (${name}): ${err.message}`; }
  }
}
