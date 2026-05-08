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
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file at the given path.',
      parameters: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content.',
      parameters: { type: 'object', properties: { filepath: { type: 'string' }, content: { type: 'string' } }, required: ['filepath', 'content'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_file',
      description: 'Replace a specific substring in a file. Use for surgical edits.',
      parameters: { type: 'object', properties: { filepath: { type: 'string' }, target: { type: 'string' }, replacement: { type: 'string' } }, required: ['filepath', 'target', 'replacement'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories in a given path.',
      parameters: { type: 'object', properties: { dirpath: { type: 'string' } }, required: ['dirpath'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_codebase',
      description: 'Search for a text pattern across the workspace using grep.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, is_regex: { type: 'boolean' } }, required: ['query'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command and return stdout/stderr.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
    }
  }
];

const SYSTEM_PROMPT = `You are Antigravity, a world-class autonomous AI coding agent. You operate inside an Electron-based IDE.

## Capabilities
- read_file, write_file, replace_in_file, list_directory, search_codebase, run_command

## Principles
1. BE AUTONOMOUS. Don't ask for clarification. Just do the work.
2. THINK step by step. Plan, execute, verify.
3. HANDLE ERRORS. If a tool fails, diagnose and retry.
4. BE THOROUGH. Handle all files without stopping.
5. Use Markdown for responses. Be concise but complete.`;

export class DeepSeekAgent {
  private openai: OpenAI;
  private messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  private cwd: string;
  private model: string;
  private maxLoopIterations = 25;

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
    await this.processAgentLoop(0);
  }

  private async processAgentLoop(iteration: number) {
    if (iteration >= this.maxLoopIterations) {
      this.window.webContents.send('chat-reply', '\n\n⚠️ Max iterations reached.');
      return;
    }

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: this.messages,
        tools: agentTools,
        tool_choice: 'auto',
      });

      const message = response.choices[0].message;
      this.messages.push(message);

      if (message.content) {
        this.window.webContents.send('chat-reply', message.content);
      }

      if (!message.tool_calls || message.tool_calls.length === 0) return;

      for (const toolCall of message.tool_calls) {
        const name = toolCall.function.name;
        this.window.webContents.send('chat-reply', `\n\n> 🔧 ${name}`);

        let args: any = {};
        try { args = JSON.parse(toolCall.function.arguments); } catch {}

        const result = await this.executeTool(name, args);
        this.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result.slice(0, 8000) });
      }

      await this.processAgentLoop(iteration + 1);
    } catch (error: any) {
      const errMsg = error?.message || String(error);
      if (errMsg.includes('rate_limit') || errMsg.includes('429')) {
        this.window.webContents.send('chat-reply', '\n\n⏳ Rate limited. Retrying in 5s...');
        await new Promise(r => setTimeout(r, 5000));
        await this.processAgentLoop(iteration);
      } else {
        this.window.webContents.send('chat-reply', `\n\n❌ Error: ${errMsg}`);
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
          this.window.webContents.send('file-changed', fp);
          return `✅ Written: ${args.filepath}`;
        }

        case 'replace_in_file': {
          const fp = resolve(args.filepath);
          let content = await fs.readFile(fp, 'utf8');
          if (!content.includes(args.target)) {
            return `❌ Target not found in ${args.filepath}. First 200 chars:\n${content.slice(0, 200)}`;
          }
          content = content.replace(args.target, args.replacement);
          await fs.writeFile(fp, content, 'utf8');
          this.window.webContents.send('file-changed', fp);
          return `✅ Replaced in: ${args.filepath}`;
        }

        case 'list_directory': {
          const entries = await fs.readdir(resolve(args.dirpath), { withFileTypes: true });
          return entries
            .filter(e => !['node_modules', '.git'].includes(e.name))
            .map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`)
            .join('\n');
        }

        case 'search_codebase': {
          const flag = args.is_regex ? '-rnE' : '-rn';
          const cmd = `grep ${flag} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist "${args.query}" .`;
          try {
            const { stdout } = await execAsync(cmd, { cwd: this.cwd, maxBuffer: 1024 * 1024 });
            return stdout || 'No matches.';
          } catch (e: any) { return e.stdout || 'No matches.'; }
        }

        case 'run_command': {
          const { stdout, stderr } = await execAsync(args.command, { cwd: this.cwd, timeout: 30000, maxBuffer: 1024 * 1024 });
          const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
          this.window.webContents.send('terminal-output', `\r\n$ ${args.command}\r\n${stdout}`);
          return output;
        }

        default: return `Unknown tool: ${name}`;
      }
    } catch (err: any) { return `Tool error (${name}): ${err.message}`; }
  }
}
