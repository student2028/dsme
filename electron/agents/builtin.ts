/**
 * DSME Built-in Agent — Direct OpenAI-compatible API (no framework dependency)
 *
 * Uses the `openai` npm package directly for:
 * - Streaming text generation via chat.completions.create
 * - Manual tool call loop with iteration guard
 * - Zero framework overhead — lightweight and transparent
 */

import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
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
  browserHover,
  browserType,
  browserScroll,
  browserBack,
  browserEval,
  browserTaskStart,
  browserTaskFinish,
  browserWaitForIdle,
  browserPressKey,
  browserListFrames,
  browserSwitchFrame,
  // Electron Native tools
  browserFind,
  browserExportCookies,
  browserImportCookies,
  browserClearSession,
  browserZoom,
  browserExportPDF,
  browserReadClipboard,
  browserWriteClipboard,
  browserPageHealth,
  // Visual Overlay tools
  browserShowOverlay,
  browserClearOverlay,
  browserHighlightRef,
  browserStopFind,
  // Advanced CDP tools
  browserUploadFile,
  browserCaptureNetwork,
  browserListNetworkRequests,
  browserGetNetworkResponse,
  browserSnapshotState,
  browserRestoreState,
  browserListDownloads,
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

// ── JSON repair (ported from tools1/cortex/llm/sanitize.py) ──
// Small models often emit malformed JSON: trailing commas, single quotes,
// Python literals (True/False/None), unquoted keys, etc.
function safeJsonParse(raw: string, fallback: any = null): any {
  if (!raw || typeof raw !== 'string') return fallback;
  raw = raw.trim();

  // Tier 1: standard JSON.parse (fast path for well-formed JSON)
  try { return JSON.parse(raw); } catch {}

  // Tier 2: manual repair (mirrors sanitize.py _manual_repair)
  let s = raw;

  // Strip markdown code blocks wrapping
  const codeBlockMatch = s.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) s = codeBlockMatch[1].trim();

  // Extract JSON region from surrounding text
  for (const startChar of ['{', '[']) {
    const idx = s.indexOf(startChar);
    if (idx > 0) { s = s.slice(idx); break; }
  }

  // Fix trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');
  // Python literals → JSON
  s = s.replace(/\bNone\b/g, 'null');
  s = s.replace(/\bTrue\b/g, 'true');
  s = s.replace(/\bFalse\b/g, 'false');
  s = s.replace(/\bNaN\b/g, 'null');
  s = s.replace(/\bInfinity\b/g, 'null');
  // Single quotes → double quotes (simple heuristic)
  s = s.replace(/'/g, '"');

  try { return JSON.parse(s); } catch {}
  return fallback;
}

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
  { type: 'function', function: { name: 'web_search', description: 'Search the web for real-time info.', parameters: { type: 'object', properties: { query: { type: 'string' }, engine: { type: 'string', enum: ['google', 'sogou', 'baidu', 'bing'], description: 'Search engine to use. Default: google.' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'fetch_url', description: 'Fetch and read content from a URL (static HTML only, no JS rendering).', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browse_page', description: 'Open a URL in a real browser with full JS rendering, then execute a custom script to interact with and extract data from the page. Use for SPAs, dynamic tables, clicking/scrolling. Script runs in page context, can use async/await, MUST return a string.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to open' }, script: { type: 'string', description: 'JavaScript to execute in page context. MUST return a string.' }, wait_before_script: { type: 'number', description: 'Ms to wait after page load. Default: 2000' }, timeout: { type: 'number', description: 'Total timeout ms. Default: 30000' } }, required: ['url', 'script'] } } },
  { type: 'function', function: { name: 'browser_task_start', description: 'Start a named multi-step browser session so all following browser_* steps appear under one timeline heading in the UI. Call once per complex browser workflow.', parameters: { type: 'object', properties: { goal: { type: 'string', description: 'Short user-visible goal, e.g. "Export CSV from dashboard"' } }, required: ['goal'] } } },
  { type: 'function', function: { name: 'browser_task_finish', description: 'End the browser session started with browser_task_start. Optionally provide a short summary for the browser panel banner.', parameters: { type: 'object', properties: { summary: { type: 'string', description: 'Outcome summary (optional)' } } } } },
  { type: 'function', function: { name: 'browser_navigate', description: 'Navigate the visible built-in browser to a URL. Prefer browser_task_start(goal) before long flows.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'browser_snapshot', description: 'Capture page text layout with element refs [e1],[e2]… Call before click/type.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_click', description: 'Click element by ref from browser_snapshot.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } } },
  { type: 'function', function: { name: 'browser_hover', description: 'Hover over an element by ref. Use this to reveal CSS dropdown menus or tooltips before taking another snapshot.', parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] } } },
  { type: 'function', function: { name: 'browser_type', description: 'Type into input/textarea by ref from browser_snapshot.', parameters: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['ref', 'text'] } } },
  { type: 'function', function: { name: 'browser_scroll', description: 'Scroll the page up or down.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] } }, required: ['direction'] } } },
  { type: 'function', function: { name: 'browser_back', description: 'Browser history back.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_eval', description: 'Run arbitrary JS in page context; must return a string. Use ONLY for reading data or debugging. NEVER use browser_eval to enumerate elements with your own [e0],[e1] labels — those fake refs will NOT work with browser_click or browser_type. Always use browser_snapshot to get real refs. Base64 image data is auto-saved to disk.', parameters: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'] } } },
  { type: 'function', function: { name: 'browser_wait_for_idle', description: 'Wait for page to become idle (no loading spinners, stable DOM). Use after triggering async operations like AI generation.', parameters: { type: 'object', properties: { timeout_ms: { type: 'number', description: 'Max wait ms. Default: 15000. For AI tasks use 60000-120000.' } } } } },
  { type: 'function', function: { name: 'browser_press_key', description: 'Press a special key (Enter, Tab, Escape, Backspace, Delete, Arrow keys, Space) using native keyboard simulation. Use this to submit forms (Enter), navigate tabs (Tab), or dismiss dialogs (Escape). This fires at the Chromium engine level — identical to a physical key press.', parameters: { type: 'object', properties: { key: { type: 'string', enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'], description: 'Key to press' } }, required: ['key'] } } },
  { type: 'function', function: { name: 'browser_list_frames', description: 'List all frames (main page + iframes) with their URLs and indices. Use this when browser_snapshot shows few or no interactive elements — the login form or content might be inside an iframe. Each frame has an index you can pass to browser_switch_frame.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_switch_frame', description: 'Switch browser tool execution context to a specific iframe by index. NOTE: browser_snapshot already uses CDP which spans ALL frames automatically — you usually do NOT need to switch frames. Only use this for edge cases like same-origin about:blank iframes not captured by CDP. Use browser_list_frames first to see available frames. Pass frameIndex=-1 to switch back to the main frame.', parameters: { type: 'object', properties: { frameIndex: { type: 'number', description: 'Frame index from browser_list_frames. Use -1 to return to main frame.' } }, required: ['frameIndex'] } } },
  { type: 'function', function: { name: 'render_html', description: 'Render a beautiful, rich HTML document directly in the IDE browser panel. Use this for highly visual results like shopping items, social media posts, image galleries, or dashboards. You can use absolute local file paths (e.g. file:///Users/...) directly in src/href attributes.', parameters: { type: 'object', properties: { html: { type: 'string', description: 'The complete HTML document string to render (include <style> tags or Tailwind via CDN for styling).' } }, required: ['html'] } } },
  // ── Electron Native tools (unique to DSME) ──
  { type: 'function', function: { name: 'browser_find', description: 'Search for text on the page using Chromium\'s built-in find-in-page. Works across shadow DOM, cross-origin iframes, and canvas text. Returns match count and auto-scrolls to the first match.', parameters: { type: 'object', properties: { text: { type: 'string', description: 'Text to search for' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'browser_stop_find', description: 'Stop find-in-page and clear all match highlights.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_export_cookies', description: 'Export browser session cookies to a JSON file. Use to save login state. Pass url to export only cookies for that domain.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Optional: export only cookies for this URL (e.g. https://google.com)' } } } } },
  { type: 'function', function: { name: 'browser_import_cookies', description: 'Import cookies from a previously exported JSON file to restore a login session.', parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Path to the cookies JSON file' } }, required: ['file_path'] } } },
  { type: 'function', function: { name: 'browser_clear_session', description: 'Clear all cookies, localStorage, and cache. Use to start fresh.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_zoom', description: 'Set page zoom level. Use when text is too small to read or page layout is broken.', parameters: { type: 'object', properties: { factor: { type: 'number', description: 'Zoom factor: 1.0=100%, 0.5=50%, 2.0=200%' } }, required: ['factor'] } } },
  { type: 'function', function: { name: 'browser_export_pdf', description: 'Export the current page as a PDF file to disk. No print dialog — direct Chromium print pipeline.', parameters: { type: 'object', properties: { output_path: { type: 'string', description: 'Optional absolute path to save the PDF. Defaults to ~/Downloads/page_<timestamp>.pdf' } } } } },
  { type: 'function', function: { name: 'browser_read_clipboard', description: 'Read the current system clipboard text. No user gesture needed (Electron Native privilege).', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_write_clipboard', description: 'Write text to the system clipboard. Useful for passing extracted page data to other apps.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } },
  { type: 'function', function: { name: 'browser_page_health', description: 'Get a quick page status summary: URL, title, loading state, network activity, error count, zoom, navigation history. Zero JS injection — instant read from Electron Native APIs. Use before snapshot to understand page state.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_show_overlay', description: 'Render ALL interactive elements as blue highlighted boxes ("X-ray vision" mode). Uses CDP Overlay — no DOM injection. Shows exactly what the agent can see and click. Run after browser_snapshot.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_clear_overlay', description: 'Remove all element highlight overlays from the page.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_highlight_ref', description: 'Highlight a specific element ref with an orange box for 3 seconds. Use to verify you are targeting the right element before clicking.', parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. "e3"' } }, required: ['ref'] } } },
  { type: 'function', function: { name: 'browser_upload_file', description: 'Set file(s) on a file input element — bypasses the native OS file picker dialog. The ref MUST be an <input type="file"> from browser_snapshot. Use this for email attachments, avatar upload, document submission, etc.', parameters: { type: 'object', properties: { ref: { type: 'string', description: 'Element ref of the file input (e.g. "e5")' }, file_paths: { type: 'array', items: { type: 'string' }, description: 'Array of absolute file paths to upload' } }, required: ['ref', 'file_paths'] } } },
  { type: 'function', function: { name: 'browser_capture_network', description: 'Capture the next network response matching a URL pattern. Call this BEFORE triggering the action that makes the request (e.g. click search). Returns the raw response body (JSON, HTML, etc.). Perfect for extracting API data from React/Vue SPAs.', parameters: { type: 'object', properties: { url_pattern: { type: 'string', description: 'Substring to match in request URLs (e.g. "/api/search", "graphql")' }, timeout_ms: { type: 'number', description: 'Max wait time in ms. Default: 15000.' } }, required: ['url_pattern'] } } },
  { type: 'function', function: { name: 'browser_list_network_requests', description: 'List recently intercepted background API/JSON network requests. Returns Request IDs and URLs. Use this if the data you want was loaded dynamically via XHR/Fetch, saving you from parsing complex DOM.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_get_network_response', description: 'Get the JSON response body of a previously intercepted network request by its Request ID. Use browser_list_network_requests first to find the ID.', parameters: { type: 'object', properties: { request_id: { type: 'string', description: 'The Request ID obtained from browser_list_network_requests' } }, required: ['request_id'] } } },
  { type: 'function', function: { name: 'browser_snapshot_state', description: 'Take a memory snapshot of the current page state (URL, Cookies, LocalStorage, SessionStorage). Use this before attempting a complex or risky sequence of actions (like filling out a long form or clicking uncertain links). Returns a state_id.', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'browser_restore_state', description: 'Instantly rollback the browser to a previously snapshotted state (Cookies, LocalStorage, URL). Use this if you made a mistake, clicked the wrong button, or got stuck on an error page.', parameters: { type: 'object', properties: { state_id: { type: 'string', description: 'The state_id returned by browser_snapshot_state' } }, required: ['state_id'] } } },
  { type: 'function', function: { name: 'browser_list_downloads', description: 'List recent file downloads triggered by the browser. Returns file paths (like ~/Downloads/file.csv) and their status. You can use read_file on these paths to process the downloaded data.', parameters: { type: 'object', properties: {} } } },
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

  resetConversation(): void {
    if (this.busy) this.abort();
    this.messages = [];
  }

  loadHistory(history: any[]): void {
    if (this.busy) this.abort();
    this.messages = history.map(m => {
      if (m.role === 'user' && m.attachments && m.attachments.some((a: any) => a.type === 'image' && a.dataUrl)) {
        const imageParts = m.attachments
          .filter((a: any) => a.type === 'image' && a.dataUrl)
          .map((a: any) => ({
            type: 'image_url',
            image_url: { url: a.dataUrl }
          }));
        
        return {
          role: 'user',
          content: [
            { type: 'text', text: m.content },
            ...imageParts
          ]
        };
      }
      return { role: m.role, content: m.content };
    });
  }
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
    const MAX_ITERATIONS = 100;
    const LOOP_TIMEOUT_MS = 600_000; // 10 min per iteration — allows for slow image/video generation
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

        // Streaming response — with graceful degradation (ported from tools1)
        // If the stream is interrupted after producing content, we keep the partial output
        // rather than failing the whole turn.
        let fullText = '';
        let toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
        let currentToolIdx = -1;
        let finishReason = '';
        let insideThink = false;
        let thinkBuffer = '';

        try {
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
            for (let i = 0; i < delta.tool_calls.length; i++) {
              const tc = delta.tool_calls[i];
              const tcIndex = tc.index !== undefined ? tc.index : i;
              if (tcIndex !== currentToolIdx) {
                currentToolIdx = tcIndex;
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
        } catch (streamErr: any) {
          // Graceful degradation (ported from tools1 _handle_streaming lines 985-989):
          // If stream interrupted AFTER producing content, keep partial output
          if (!fullText && toolCalls.length === 0) {
            throw streamErr; // Nothing collected → re-throw to outer catch
          }
          console.warn(`[BuiltinAgent] Streaming interrupted (${streamErr.message}), keeping partial output (${fullText.length} chars, ${toolCalls.length} tool calls)`);
          finishReason = 'error';
        }

        // Fallback text parsing if no native tool calls were streamed
        if (toolCalls.length === 0 && fullText.length > 0) {
          const availableTools = TOOLS.map(t => t.function.name);
          const parsed = this.parseTextToolCalls(fullText, availableTools);
          if (parsed.length > 0) {
            console.log(`[BuiltinAgent] Fallback: parsed ${parsed.length} tool call(s) from text`);
            for (let i = 0; i < parsed.length; i++) {
              toolCalls.push({
                id: `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
                name: parsed[i].name,
                arguments: typeof parsed[i].args === 'string' ? parsed[i].args : JSON.stringify(parsed[i].args)
              });
            }
            // Clear content to prevent duplication if we parsed it into tool calls
            fullText = '';
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

        // No tool calls → check for truncation
        if (toolCalls.length === 0) {
          // Handle finish_reason='tool_calls' (Google/Gemma models use this instead of 'stop')
          // but since we didn't capture tool calls, treat as normal stop
          if (finishReason === 'length') {
            this.truncationCount++;
            if (this.truncationCount >= 5) {
              console.error('[BuiltinAgent] Max consecutive truncations (5). Stopping.');
              this.send('chat-stream-token', '\n\n⚠️ 模型输出被截断多次，已停止重试。');
              this.truncationCount = 0;
            } else {
              console.warn(`[BuiltinAgent] Output truncated, continuing loop (${this.truncationCount}/5)`);
              clearTimeout(timeoutId);
              continue;
            }
          } else {
            this.truncationCount = 0;
          }
          this.retryCount = 0;
          clearTimeout(timeoutId);
          break;
        }

        // Also handle finish_reason='tool_calls' (Google/Gemma) — same as normal tool call execution
        // (the code below already handles it since toolCalls.length > 0)

        // Execute tools
        for (const tc of toolCalls) {
          this.send('chat-status', `tool:${tc.name}`);
          this.send('chat-stream-token', `\n\n> **${tc.name}**\n`);
          console.log(`[BuiltinAgent] Tool: ${tc.name}`);

          let args: any = {};
          args = safeJsonParse(tc.arguments, {});

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
        const msg = err?.message || String(err);
        if (err?.name === 'AbortError' || msg === 'Request was aborted.' || msg === 'aborted') return;
        
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

    // Sanitize malformed tool call arguments in history (ported from tools1 _sanitize_api_messages)
    // Prevents 400 Bad Request from providers rejecting replayed tool calls with broken JSON
    for (const msg of this.messages) {
      if ((msg as any).role === 'assistant' && (msg as any).tool_calls) {
        for (const tc of (msg as any).tool_calls) {
          if (tc.function?.arguments && typeof tc.function.arguments === 'string') {
            const parsed = safeJsonParse(tc.function.arguments);
            if (parsed !== null) {
              const normalized = JSON.stringify(parsed);
              if (normalized !== tc.function.arguments) {
                console.log(`[BuiltinAgent] Sanitized malformed tool call args for ${tc.function.name}`);
                tc.function.arguments = normalized;
              }
            }
          }
        }
      }
    }

    for (const msg of this.messages) {
      if (typeof msg.content === 'string' && msg.content.length > maxContentLen && msg.role !== 'user') {
        msg.content = msg.content.slice(0, maxContentLen) + '\n\n[DISPLAY_TRUNCATED: Content was trimmed to fit context window. The original data was fully collected. Do NOT retry the tool call.]';
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
    if (result.length <= cap) return result;
    // Count lines/items to give model a sense of completeness
    const totalLines = result.split('\n').length;
    return result.slice(0, cap) +
      `\n\n[DISPLAY_TRUNCATED: Output was ${result.length} chars / ${totalLines} lines. ` +
      `Only the first ${cap} chars are shown above, but the full data was successfully collected. ` +
      `Do NOT retry this tool call — the data is complete.]`;
  }

  // ── Tool execution ──
  private async executeTool(name: string, args: any): Promise<string> {
    const resolve = (p: string) => path.resolve(this.cwd, p);

    // ── Normalize argument names (small models use variant casing/naming) ──
    // e.g. URL→url, Command→command, FilePath→filepath, Query→query, etc.
    args = this.normalizeToolArgs(name, args);

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
          const engineLabel = args.engine || 'google';
          this.send('chat-stream-token', `\n正在用 ${engineLabel} 搜索：${args.query}\n`);
          const started = Date.now();
          const rawResult = await webSearch(args.query, args.engine);
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
        case 'fetch_url': {
          if (!args.url) return 'Error: url is required for fetch_url. Please provide the URL to fetch.';
          return await fetchUrl(args.url);
        }
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
          if (!args.url) return 'Error: url is required for browser_navigate. Please provide the URL to navigate to.';
          this.send('chat-stream-token', `\n浏览器导航 → ${args.url}\n`);
          return await browserNavigate(args.url);
        }
        case 'browser_snapshot': return await browserSnapshot();
        case 'browser_click': {
          this.send('chat-stream-token', `\n浏览器点击 ${args.ref}\n`);
          return await browserClick(args.ref);
        }
        case 'browser_hover': {
          this.send('chat-stream-token', `\n浏览器悬停 ${args.ref}\n`);
          return await browserHover(args.ref);
        }
        case 'browser_type': {
          this.send('chat-stream-token', `\n浏览器输入 ${args.ref}\n`);
          return await browserType(args.ref, args.text);
        }
        case 'browser_scroll': return await browserScroll(args.direction);
        case 'browser_back': return await browserBack();
        case 'browser_eval': {
          this.send('chat-stream-token', `\n浏览器执行脚本…\n`);
          const evalResult = await browserEval(args.script, this.cwd);
          // Auto-save large results to file to avoid context truncation loops
          if (evalResult.length > 50_000 && !evalResult.startsWith('Image saved to')) {
            const filename = `scratch/browser_eval_${Date.now()}.txt`;
            const fp = path.resolve(this.cwd, filename);
            await fs.mkdir(path.dirname(fp), { recursive: true });
            await fs.writeFile(fp, evalResult, 'utf8');
            const lineCount = evalResult.split('\n').length;
            const preview = evalResult.slice(0, 2000);
            return `Data saved to ${filename} (${evalResult.length} chars, ${lineCount} lines).\n\nPreview (first 2000 chars):\n${preview}\n\n[Full data is in the file. Do NOT re-run this script — data collection is complete.]`;
          }
          return evalResult;
        }
        case 'browser_wait_for_idle': {
          this.send('chat-stream-token', `\n等待页面空闲…\n`);
          return await browserWaitForIdle(args.timeout_ms);
        }
        case 'browser_press_key': {
          this.send('chat-stream-token', `\n按下按键 ${args.key}\n`);
          return await browserPressKey(args.key);
        }
        case 'browser_list_frames': {
          this.send('chat-stream-token', `\n列出页面 frames…\n`);
          return await browserListFrames();
        }
        case 'browser_switch_frame': {
          const idx = args.frameIndex ?? args.frame_index ?? args.index ?? 0;
          this.send('chat-stream-token', `\n切换到 frame ${idx}…\n`);
          return await browserSwitchFrame(idx);
        }
        case 'render_html': {
          const { browserViewManager } = require('../browser-view-manager');
          const { BrowserWindow } = require('electron');
          const allWindows = BrowserWindow.getAllWindows();
          const mainWindow = allWindows.find((w: any) => w.getTitle()?.includes('DSME')) || allWindows[0];
          if (mainWindow) mainWindow.webContents.send('browser-panel-open');

          this.send('chat-stream-token', `\n正在渲染丰富的 HTML 视图...\n`);
          await browserViewManager.loadHTML(args.html);
          return 'HTML rendered successfully in the IDE browser panel. Tell the user to look at the browser panel.';
        }
        // ── Electron Native tools ──
        case 'browser_find': {
          return await browserFind(args.text);
        }
        case 'browser_stop_find': {
          return await browserStopFind();
        }
        case 'browser_export_cookies': {
          return await browserExportCookies(args.url);
        }
        case 'browser_import_cookies': {
          return await browserImportCookies(args.file_path || args.filePath);
        }
        case 'browser_clear_session': {
          return await browserClearSession();
        }
        case 'browser_zoom': {
          return await browserZoom(args.factor);
        }
        case 'browser_export_pdf': {
          return await browserExportPDF(args.output_path || args.outputPath);
        }
        case 'browser_read_clipboard': {
          return await browserReadClipboard();
        }
        case 'browser_write_clipboard': {
          return await browserWriteClipboard(args.text);
        }
        case 'browser_page_health': {
          return await browserPageHealth();
        }
        case 'browser_show_overlay': {
          return await browserShowOverlay();
        }
        case 'browser_clear_overlay': {
          return await browserClearOverlay();
        }
        case 'browser_highlight_ref': {
          return await browserHighlightRef(args.ref);
        }
        case 'browser_upload_file': {
          return await browserUploadFile(args.ref, args.file_paths || args.filePaths);
        }
        case 'browser_capture_network': {
          return await browserCaptureNetwork(args.url_pattern || args.urlPattern, args.timeout_ms || args.timeoutMs);
        }
        case 'browser_list_network_requests': {
          return await browserListNetworkRequests();
        }
        case 'browser_get_network_response': {
          return await browserGetNetworkResponse(args.request_id || args.requestId);
        }
        case 'browser_snapshot_state': {
          return await browserSnapshotState();
        }
        case 'browser_restore_state': {
          return await browserRestoreState(args.state_id || args.stateId);
        }
        case 'browser_list_downloads': {
          return await browserListDownloads();
        }
        default: return `Unknown tool: ${name}`;
      }
    } catch (e: any) {
      return `Tool error (${name}): ${e.code === 'ENOENT' ? 'File not found' : e.message}`;
    }
  }

  /**
   * Normalize tool argument names for small model compatibility.
   * Small/local models (Gemma, Qwen-small, Llama) often use variant casing
   * or alternative parameter names. This normalizes them to match our schema.
   */
  private normalizeToolArgs(toolName: string, args: any): any {
    if (!args || typeof args !== 'object') return args;

    // Build a case-insensitive lookup: lowercase key → original value
    const lowerMap = new Map<string, any>();
    for (const [key, val] of Object.entries(args)) {
      lowerMap.set(key.toLowerCase(), val);
    }

    // Helper: find a value by trying multiple key variants
    const find = (...keys: string[]): any => {
      for (const k of keys) {
        if (args[k] !== undefined) return args[k];
      }
      // Case-insensitive fallback
      for (const k of keys) {
        const v = lowerMap.get(k.toLowerCase());
        if (v !== undefined) return v;
      }
      return undefined;
    };

    switch (toolName) {
      case 'browser_navigate':
      case 'fetch_url':
        if (!args.url) args.url = find('url', 'URL', 'Url', 'uri', 'URI', 'href', 'link');
        break;
      case 'browser_click':
        if (!args.ref) args.ref = find('ref', 'Ref', 'REF', 'element', 'selector', 'id');
        break;
      case 'browser_type':
        if (!args.ref) args.ref = find('ref', 'Ref', 'REF', 'element');
        if (!args.text) args.text = find('text', 'Text', 'value', 'content', 'input');
        break;
      case 'browser_scroll':
        if (!args.direction) args.direction = find('direction', 'Direction', 'dir');
        break;
      case 'browser_press_key':
        if (!args.key) args.key = find('key', 'Key', 'keyName');
        break;
      case 'browser_eval':
        if (!args.script) args.script = find('script', 'Script', 'code', 'js', 'javascript');
        break;
      case 'web_search':
        if (!args.query) args.query = find('query', 'Query', 'q', 'search', 'keyword');
        break;
      case 'read_file':
        if (!args.filepath) args.filepath = find('filepath', 'FilePath', 'path', 'file', 'filename');
        break;
      case 'write_file':
        if (!args.filepath) args.filepath = find('filepath', 'FilePath', 'path', 'file', 'filename');
        if (!args.content) args.content = find('content', 'Content', 'text', 'data', 'body');
        break;
      case 'run_command':
        if (!args.command) args.command = find('command', 'Command', 'CommandLine', 'cmd', 'shell', 'exec');
        break;
      case 'list_directory':
        if (!args.dirpath) args.dirpath = find('dirpath', 'DirPath', 'path', 'directory', 'dir', 'DirectoryPath');
        break;
      case 'search_codebase':
        if (!args.query) args.query = find('query', 'Query', 'q', 'search', 'pattern');
        break;
      case 'replace_in_file':
        if (!args.filepath) args.filepath = find('filepath', 'FilePath', 'path', 'file');
        if (!args.target) args.target = find('target', 'Target', 'search', 'old', 'find');
        if (!args.replacement) args.replacement = find('replacement', 'Replacement', 'replace', 'new');
        break;
      case 'browse_page':
        if (!args.url) args.url = find('url', 'URL', 'Url', 'uri');
        if (!args.script) args.script = find('script', 'Script', 'code', 'js');
        break;
      case 'browser_task_start':
        if (!args.goal) args.goal = find('goal', 'Goal', 'task', 'description', 'title');
        break;
      case 'render_html':
        if (!args.html) args.html = find('html', 'HTML', 'content', 'code');
        break;
    }
    return args;
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
    // Strategy 1: Hermes (uses safeJsonParse for resilient parsing)
    const hermesMatch = text.match(/\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/);
    if (hermesMatch) {
      const calls = safeJsonParse(hermesMatch[1]);
      if (Array.isArray(calls)) {
        return calls.filter((c: any) => c.name && availableTools.includes(c.name))
          .map((c: any) => ({ name: c.name, args: c.arguments || c.parameters || {} }));
      }
    }
    // Strategy 2: XML
    const xmlRegex = /<function=([^>]+)>([\s\S]*?)<\/function>/g;
    const xmlCalls: { name: string; args: any }[] = [];
    let xmlMatch;
    while ((xmlMatch = xmlRegex.exec(text)) !== null) {
      const name = xmlMatch[1].trim();
      if (!availableTools.includes(name)) continue;
      const parsed = safeJsonParse(xmlMatch[2].trim());
      xmlCalls.push({ name, args: parsed ?? {} });
    }
    if (xmlCalls.length > 0) return xmlCalls;
    // Strategy 3: JSON code blocks
    // Strategy 3: JSON code blocks (matches tools1 CODE_BLOCK_PATTERN with additional key heuristics)
    const jsonBlockRegex = /```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?```/g;
    const jsonCalls: { name: string; args: any }[] = [];
    let jsonMatch;
    while ((jsonMatch = jsonBlockRegex.exec(text)) !== null) {
      const data = safeJsonParse(jsonMatch[1]);
      if (data && typeof data === 'object') {
        // Format: {"name": "tool_name", "parameters": {...}} or {"name": "...", "arguments": {...}}
        if (data.name && availableTools.includes(data.name)) {
          jsonCalls.push({ name: data.name, args: data.parameters || data.arguments || {} });
        }
        // Format: raw args with known parameter keys (like tools1 _try_parse_tool_json)
        else if (!data.name) {
          const paramKeyMap: Record<string, string> = {
            command: 'run_command', filepath: 'read_file', query: 'web_search',
            url: 'fetch_url', dirpath: 'list_directory', ref: 'browser_click',
          };
          for (const [key, toolName] of Object.entries(paramKeyMap)) {
            if (key in data && availableTools.includes(toolName)) {
              jsonCalls.push({ name: toolName, args: data });
              break;
            }
          }
        }
      }
    }
    if (jsonCalls.length > 0) return jsonCalls;
    // Strategy 4: Bare JSON
    const bareRegex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"(?:parameters|arguments)"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
    const bareCalls: { name: string; args: any }[] = [];
    let bareMatch;
    while ((bareMatch = bareRegex.exec(text)) !== null) {
      const name = bareMatch[1];
      if (!availableTools.includes(name)) continue;
      const parsed = safeJsonParse(bareMatch[2]);
      if (parsed && typeof parsed === 'object') bareCalls.push({ name, args: parsed });
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
