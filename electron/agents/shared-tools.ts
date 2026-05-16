/**
 * DSME Shared Tool Implementations
 *
 * Extracted from vercel.ts and builtin.ts to eliminate code duplication.
 * Both agent kernels now import from this single source of truth.
 *
 * Security: This module uses NO shell commands (exec/spawn).
 * All external interactions go through native Node.js APIs or Electron IPC.
 */

// ── Search extract scripts (shared across all engines) ──
const SEARCH_EXTRACT_HELPERS = `
function cleanText(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim();
}
function pushResult(results, title, snippet, url) {
  title = cleanText(title);
  snippet = cleanText(snippet);
  url = cleanText(url);
  if (!title || title.length < 4) return;
  var line = title;
  if (snippet && !title.includes(snippet)) line += ' — ' + snippet;
  if (url) line += ' — ' + url;
  if (line.length > 20 && !results.some(function(x) { return x.slice(0, 80) === line.slice(0, 80); })) {
    results.push(line.slice(0, 420));
  }
}
function genericSearchExtract(preferredSelectors) {
  var results = [];
  var special = extractSpecialAnswer();
  if (special) results.push(special);
  preferredSelectors.forEach(function(selector) {
    document.querySelectorAll(selector).forEach(function(item) {
      if (results.length >= 8) return;
      var title = item.querySelector('h1,h2,h3,.vrTitle,.title,[role="heading"]');
      var link = item.querySelector('a[href]');
      var snippet = item.querySelector('p,.VwiC3b,.IsZvec,[data-sncf],.str_info,.space-txt,.b_caption,.b_snippet');
      pushResult(results, title && title.innerText, snippet && snippet.innerText, link && link.href);
    });
  });
  if (results.length < 3) {
    document.querySelectorAll('a[href]').forEach(function(link) {
      if (results.length >= 8) return;
      var href = link.href || '';
      var text = cleanText(link.innerText || link.textContent);
      if (!/^https?:/.test(href)) return;
      if (href.includes('/search?') || href.includes('javascript:')) return;
      if (text.length < 8 || text.length > 120) return;
      var container = link.closest('div,article,section,li');
      var snippet = container ? cleanText(container.innerText).replace(text, '').slice(0, 180) : '';
      pushResult(results, text, snippet, href);
    });
  }
  if (results.length === 0) {
    var body = cleanText(document.body && document.body.innerText).slice(0, 1200);
    return body ? 'Page text:\\n' + body : '';
  }
  return results.slice(0, 8).join('\\n');
}
function readFirst(selectors) {
  for (var i = 0; i < selectors.length; i++) {
    var node = document.querySelector(selectors[i]);
    var text = cleanText(node && (node.innerText || node.textContent));
    if (text) return text;
  }
  return '';
}
/** Avoid "34" + "93" → "3493" when #wob_ttm accidentally picks humidity/precip digits instead of °C/°F. */
function normalizeWeatherTemp(tempRaw, unitRaw) {
  var t = cleanText(tempRaw);
  var u = cleanText(unitRaw);
  if (!t) return '';
  if (/°|℃|℉/.test(t)) return t;
  var numOnly = t.replace(/\\s/g, '');
  if (/^-?\\d{1,3}(\\.\\d+)?$/.test(numOnly)) {
    var uTrim = u.replace(/\\s/g, '');
    var looksLikeUnit = /°|℃|℉/.test(u) || /^°?[CFcf]$/.test(uTrim) || /^[CFcf]°$/.test(uTrim);
    if (looksLikeUnit) return t + (u.charAt(0) === '°' ? '' : ' ') + u;
    return t + '°';
  }
  return t;
}
function extractSpecialAnswer() {
  var body = cleanText(document.body && (document.body.innerText || document.body.textContent));
  var weatherRoot = document.querySelector('#wob_wc,div[data-attrid*="weather"],div[aria-label*="天气"],div[aria-label*="weather"]');
  var looksLikeWeather = weatherRoot || (body.includes('天气') && body.includes('温度') && body.includes('降水概率') && /\\d+\\s*°/.test(body));
  if (looksLikeWeather) {
    var location = readFirst(['#wob_loc','[data-attrid="title"]','[role="heading"]']);
    var time = readFirst(['#wob_dts']);
    var temp = readFirst(['#wob_tm']);
    if (!temp) temp = readFirst(['[aria-label*="°"]']);
    var unit = readFirst(['#wob_ttm']);
    var condition = readFirst(['#wob_dc']);
    var precip = readFirst(['#wob_pp']);
    var humidity = readFirst(['#wob_hm']);
    var wind = readFirst(['#wob_ws']);
    if (!temp) {
      var tempMatch = body.match(/(\\d{1,3}\\s*°\\s*[CF℃℉]?)/);
      temp = tempMatch ? tempMatch[1] : '';
    }
    temp = normalizeWeatherTemp(temp, unit);
    if (!condition) {
      var conditionMatch = body.match(/天气\\s*([\\u4e00-\\u9fa5]{1,8})/);
      condition = conditionMatch ? conditionMatch[1] : '';
    }
    var parts = [];
    if (location) parts.push(location);
    if (time) parts.push(time);
    if (temp) parts.push('温度 ' + temp);
    if (condition) parts.push('天气 ' + condition);
    if (precip) parts.push('降水概率 ' + precip);
    if (humidity) parts.push('湿度 ' + humidity);
    if (wind) parts.push('风速 ' + wind);
    if (parts.length >= 2) return '天气卡片：' + parts.join('，');
    var weatherSlice = body.match(/中国[^\\n]{0,80}天气[\\s\\S]{0,260}(温度|降水概率|风力|风速)[\\s\\S]{0,180}/);
    if (weatherSlice) return '天气卡片：' + cleanText(weatherSlice[0]).slice(0, 420);
  }
  return '';
}
`;

const GOOGLE_EXTRACT = `(function(){${SEARCH_EXTRACT_HELPERS};return genericSearchExtract(['#search .g','#rso .g','#rso [data-sokoban-container]','div[data-header-feature]']);})()`;

const SOGOU_EXTRACT = `(function(){${SEARCH_EXTRACT_HELPERS};return genericSearchExtract(['.vrwrap','.rb','.results > div','.result']);})()`;

// ── Command safety blacklist ──
export const BLOCKED_COMMANDS = ['rm -rf /', 'mkfs', ':(){', 'dd if=', '> /dev/sd'];

export function countSearchResultLines(result: string): number {
  return result
    .split('\n')
    .map(line => line.trim())
    .filter(line =>
      line &&
      !line.startsWith('Results from ') &&
      line !== '---' &&
      !line.startsWith('WEB_SEARCH_') &&
      !line.startsWith('QUERY:') &&
      !line.startsWith('RESULT_COUNT:') &&
      !line.startsWith('INTERPRETATION_HINT:') &&
      !/^No results found for /i.test(line) &&
      !/^Search timeout for /i.test(line) &&
      !/^Error:/i.test(line)
    )
    .length;
}

export function hasUsableSearchResults(result: string): boolean {
  const text = String(result || '').trim();
  if (!text) return false;
  if (/^(Search timeout|No results found|Error:)/i.test(text)) return false;
  return countSearchResultLines(text) > 0;
}

export function formatWebSearchResult(query: string, result: string): string {
  const usable = hasUsableSearchResults(result);
  const count = countSearchResultLines(result);
  const status = usable ? 'ok' : 'empty';
  const hint = usable
    ? 'Search parsing succeeded. Use these snippets to answer directly; do not call web_search again unless the user asks for more sources.'
    : 'Search parsing did not find usable snippets. You may try one alternate query once.';
  return [
    `WEB_SEARCH_STATUS: ${status}`,
    `QUERY: ${query}`,
    `RESULT_COUNT: ${count}`,
    `INTERPRETATION_HINT: ${hint}`,
    '',
    result,
  ].join('\n');
}

export function isCommandBlocked(cmd: string): boolean {
  return BLOCKED_COMMANDS.some(b => cmd.includes(b));
}

// ── Codebase grep via spawn (injection-proof) ──
import { spawn } from 'node:child_process';

export function searchCodebase(query: string, cwd: string, isRegex = false): Promise<string> {
  return new Promise((resolve) => {
    const flag = isRegex ? '-rnE' : '-rn';
    const proc = spawn('grep', [
      flag,
      '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist',
      '--', query, '.'
    ], { cwd });
    let stdout = '';
    proc.stdout.on('data', d => {
      stdout += d;
      if (stdout.length > 1024 * 1024) proc.kill(); // 1MB cap
    });
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      const result = stdout || 'No matches.';
      resolve(result);
    });
    proc.on('error', () => resolve('No matches.'));
  });
}

// ── Web search — uses BrowserViewManager directly (no IPC to renderer) ──
// Navigates the WebContentsView to search engines, extracts results via executeJS.
export async function webSearch(query: string): Promise<string> {
  if (!query) return 'Error: query is required';

  const { browserViewManager } = require('../browser-view-manager');
  const { BrowserWindow: BW } = require('electron');
  const q = encodeURIComponent(query);

  // Ensure browser panel is visible so user can see the search
  const allWindows = BW.getAllWindows();
  const mainWindow = allWindows.find((w: any) => w.getTitle()?.includes('DSME')) || allWindows[0];
  if (mainWindow) mainWindow.webContents.send('browser-panel-open');

  const engines = [
    { label: 'Sogou', url: `https://www.sogou.com/web?query=${q}`, extractJS: SOGOU_EXTRACT },
    { label: 'Google', url: `https://www.google.com/search?q=${q}&hl=zh-CN`, extractJS: GOOGLE_EXTRACT },
  ];

  for (const engine of engines) {
    try {
      const navResult = await browserViewManager.navigate(engine.url);
      if (navResult.startsWith('Navigation error:') && !navResult.includes('ERR_ABORTED')) {
        continue;
      }

      // Wait for dynamic content to load
      await new Promise(r => setTimeout(r, 2000));

      // Extract search results
      const text = await browserViewManager.executeJS(engine.extractJS, 10000);
      if (text && text.length > 20 && !text.startsWith('Script error:') && !text.startsWith('[evaluate:')) {
        return `Results from ${engine.label}:\n${text}`;
      }
    } catch (e: any) {
      console.warn(`[webSearch] ${engine.label} failed:`, e.message);
    }
  }

  return `No results found for "${query}".`;
}

// ── Fetch URL (Node.js native — no shell, no injection risk) ──
export async function fetchUrl(url: string): Promise<string> {
  if (!url) return 'Error: url is required';
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol)) return 'Error: only http/https URLs supported';
  } catch { return 'Error: invalid URL'; }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!resp.ok) return `Fetch error: HTTP ${resp.status} ${resp.statusText}`;

    const html = await resp.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 15000);
    return text ? `URL: ${url}\n\n${text}` : `No content from: ${url}`;
  } catch (e: any) {
    if (e.name === 'AbortError') return `Fetch error: timeout after 25s for ${url}`;
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
- web_search returns machine-readable metadata. If \`WEB_SEARCH_STATUS: ok\` and \`RESULT_COUNT > 0\`, parsing succeeded; answer directly from those snippets.
- Do not call web_search again after a successful \`WEB_SEARCH_STATUS: ok\` in the same turn. Re-querying wastes time and makes the UX worse.
- If web_search returns enough snippets to answer the user, answer directly from those results. Do not run another search or fetch pages just to confirm.
- Use fetch_url only when the search snippets are ambiguous, incomplete, contradictory, or the user asked for source-level detail.
- Synthesize results from multiple sources into a clear, authoritative answer

### Browse Page (Interactive Browser)
- Use browse_page when you need to interact with a page: click buttons, fill forms, navigate tabs, scroll, or extract data from JS-rendered SPAs.
- **Step 1 — Reconnaissance**: First call browse_page with a simple script like \`document.title + '\\\\n' + document.body.innerText.slice(0, 3000)\` to understand the page structure.
- **Step 2 — Action**: Write a self-contained async JS script that performs clicks, waits, and extracts data.
- The script runs in page context with full DOM access. It MUST return a string.
- Prefer browse_page over fetch_url for any page that uses client-side rendering.

### Browser-Use (Long-running Browser Agent)
Use browser_* tools for complex, multi-step browser tasks on a **persistent visible webview** — the user sees navigation, loading, and extraction like a real browser session.

**Long workflows (3+ steps)** — reduce confusion and keep one timeline:
1. Call **browser_task_start(goal)** once with a short goal string (shown as the panel heading).
2. Run **browser_navigate → browser_snapshot → interact → browser_snapshot** in a loop until done.
3. Call **browser_task_finish(summary)** when finished (optional **summary** appears in the banner).

**Pattern: navigate → snapshot → act → snapshot → repeat**
1. browser_navigate(url) to open a page
2. browser_snapshot() to see elements with refs [e1], [e2]...
3. browser_click(ref) / browser_type(ref, text) / browser_scroll(direction) to interact
4. browser_snapshot() again after navigation or DOM changes — refs become stale
- ALWAYS snapshot before clicking — refs change after page updates
- The webview is persistent — login state carries across calls
- Prefer browser_* (step-by-step, visible) over browse_page when the task needs steering, verification between actions, or user trust through transparency
- Prefer browse_page only when a single scripted interaction block is enough (one URL + one returning script)
- Users can **copy the session as Markdown**, expand each step's **raw output**, use **← 后退** without affecting the agent, or **clear the timeline** while keeping the page open — use these for audits and recovery on long tasks.

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
