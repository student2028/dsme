/**
 * DSME Shared Tool Implementations
 *
 * Extracted from vercel.ts and builtin.ts to eliminate code duplication.
 * Both agent kernels now import from this single source of truth.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ── Search extract scripts (shared across all engines) ──
const GOOGLE_EXTRACT = `(function(){var r=[];document.querySelectorAll('#search .g, #rso .g').forEach(function(g){var t=g.querySelector('h3');var s=g.querySelector('.VwiC3b, .IsZvec, [data-sncf], .s3v9rd');if(t){var x=t.innerText;if(s)x+=' — '+s.innerText;if(x.length>10)r.push(x)}});return r.slice(0,8).join('\\n')})()`;

const SOGOU_EXTRACT = `(function(){var r=[];document.querySelectorAll('.vrwrap, .rb').forEach(function(i){var t=i.querySelector('h3, .vrTitle');var s=i.querySelector('.space-txt, .str-text-info, .str_info, p');if(t){var x=t.innerText;if(s)x+=' — '+s.innerText;if(x.length>10)r.push(x)}});return r.slice(0,8).join('\\n')})()`;

const BING_EXTRACT = `(function(){var r=[];document.querySelectorAll('.b_algo').forEach(function(i){var t=i.querySelector('h2');var s=i.querySelector('.b_caption p, .b_algoSlug, .b_snippet');if(t){var x=t.innerText;if(s)x+=' — '+s.innerText;if(x.length>10)r.push(x)}});return r.slice(0,8).join('\\n')})()`;

// ── Command safety blacklist ──
export const BLOCKED_COMMANDS = ['rm -rf /', 'mkfs', ':(){', 'dd if=', '> /dev/sd'];

export function isCommandBlocked(cmd: string): boolean {
  return BLOCKED_COMMANDS.some(b => cmd.includes(b));
}

// ── Web search via Electron BrowserWindow ──
export async function webSearch(query: string): Promise<string> {
  if (!query) return 'Error: query is required';
  const q = encodeURIComponent(query);
  const { BrowserWindow: BW } = require('electron');

  function searchVia(url: string, extractJS: string, label: string): Promise<string | null> {
    return new Promise((resolve) => {
      const w = new BW({
        width: 1024, height: 768, show: true,
        title: `DSME Search — ${label}`,
        alwaysOnTop: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      });
      w.focus();

      const t = setTimeout(() => { w.destroy(); resolve(null); }, 8000);

      w.webContents.on('did-finish-load', async () => {
        try {
          await new Promise(r => setTimeout(r, 1500));
          const result = await w.webContents.executeJavaScript(extractJS);
          clearTimeout(t); w.destroy();
          resolve(result && result.trim().length > 20
            ? `Web search results for "${query}" (${label}):\n${result.trim()}`
            : null);
        } catch { clearTimeout(t); w.destroy(); resolve(null); }
      });

      w.webContents.on('did-fail-load', () => { clearTimeout(t); w.destroy(); resolve(null); });
      w.loadURL(url).catch(() => { clearTimeout(t); w.destroy(); resolve(null); });
    });
  }

  try {
    const promises = [
      searchVia(`https://cn.bing.com/search?q=${q}`, BING_EXTRACT, 'Bing'),
      searchVia(`https://www.sogou.com/web?query=${q}`, SOGOU_EXTRACT, 'Sogou'),
      searchVia(`https://www.google.com/search?q=${q}&hl=zh-CN`, GOOGLE_EXTRACT, 'Google'),
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

    return firstSuccess || `No results found for "${query}". Search engines did not return usable content.`;
  } catch (e: any) {
    return `Search error: ${e.message}`;
  }
}

// ── Fetch URL (static HTML) ──
export async function fetchUrl(url: string): Promise<string> {
  if (!url) return 'Error: url is required';
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return 'Error: only http/https URLs supported';
  } catch { return 'Error: invalid URL'; }

  const safeUrl = url.replace(/[;&|`$(){}!#']/g, '');
  const proxyArgs = process.env.https_proxy ? `--proxy ${process.env.https_proxy}` : '';
  try {
    const cmd = `curl -sS --max-time 20 ${proxyArgs} -L -H "User-Agent: Mozilla/5.0" "${safeUrl}"`;
    const { stdout } = await execAsync(cmd, { timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
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

// ── System prompt builder (shared core) ──
export function buildSystemPromptBase(cwd: string): string {
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

### Browse Page (Interactive Browser)
- Use browse_page when you need to interact with a page: click buttons, fill forms, navigate tabs, scroll, or extract data from JS-rendered SPAs.
- **Step 1 — Reconnaissance**: First call browse_page with a simple script like \`document.title + '\\n' + document.body.innerText.slice(0, 3000)\` to understand the page structure.
- **Step 2 — Action**: Write a self-contained async JS script that performs clicks, waits, and extracts data.
- The script runs in page context with full DOM access. It MUST return a string.
- Prefer browse_page over fetch_url for any page that uses client-side rendering.

### File Editing (replace_in_file)
- The 'target' parameter must be an EXACT character-for-character match including whitespace, indentation, and newlines.
- Copy-paste from the read_file output to ensure exact match. Never type from memory.
- If a replacement fails with "Target not found", re-read the file and try again with the exact text.

## Safety
- Ask before destructive, irreversible, or externally visible actions.
- Do not modify files outside the workspace unless explicitly asked.
- Never expose API keys, tokens, or credentials.
- **CRITICAL**: Never create temporary, test, or isolated files directly in the workspace root. ALWAYS place unrelated scripts or generated standalone documents inside a \`scratch/\` folder (create it if missing).`;
}
