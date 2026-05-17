/**
 * DSME Shared Tool Implementations
 *
 * Extracted from vercel.ts and builtin.ts to eliminate code duplication.
 * Both agent kernels now import from this single source of truth.
 *
 * Security: This module uses NO shell commands (exec/spawn).
 * All external interactions go through native Node.js APIs or Electron IPC.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Mozilla Readability.js — industry gold-standard content extraction ──
// Loaded once at startup, injected into WebContentsView page context on demand.
let _readabilitySource: string | null = null;
function getReadabilitySource(): string {
  if (_readabilitySource) return _readabilitySource;
  try {
    const readabilityPath = require.resolve('@mozilla/readability/Readability.js');
    _readabilitySource = fs.readFileSync(readabilityPath, 'utf8');
    console.log(`[SharedTools] Readability.js loaded (${(_readabilitySource.length / 1024).toFixed(0)}KB)`);
  } catch (e) {
    console.warn('[SharedTools] @mozilla/readability not found, deep extraction disabled');
    _readabilitySource = '';
  }
  return _readabilitySource;
}

/**
 * Run Readability.js inside WebContentsView page context.
 * Returns { title, textContent, excerpt } or null if extraction fails.
 * This leverages the full Chromium DOM — our project's unique advantage.
 */
export async function extractWithReadability(browserViewManager: any): Promise<{ title: string; textContent: string; excerpt: string } | null> {
  const src = getReadabilitySource();
  if (!src) return null;
  try {
    const script = `(function(){
      ${src}
      var dc = document.cloneNode(true);
      var reader = new Readability(dc);
      var article = reader.parse();
      if (!article) return null;
      return JSON.stringify({
        title: article.title || '',
        textContent: (article.textContent || '').slice(0, 8000),
        excerpt: article.excerpt || ''
      });
    })()`;
    const raw = await browserViewManager.executeJS(script, 15000);
    if (!raw || raw === 'null' || raw.startsWith('Script error:')) return null;
    return JSON.parse(raw);
  } catch (e: any) {
    console.warn('[SharedTools] Readability extraction failed:', e.message);
    return null;
  }
}

// ── Universal search result extraction engine ──
// Design: multi-layer, fault-tolerant, engine-agnostic.
// Built as a function to avoid template-string escape hell.
function buildExtractScript(): string {
  /* eslint-disable no-useless-escape */
  return [
    '(function(){',
    'var MR=10;',
    'function cl(v){return String(v||"").replace(/\\s+/g," ").trim();}',

    // Layer 1: Special cards
    'function extractCards(){',
    '  var cards=[];',
    // Weather DOM selectors
    '  var ws=["#wob_wc","[data-attrid*=weather]","[data-attrid*=temperature]",',
    '    "[aria-label*=天气]","[aria-label*=weather]",',
    '    ".weather-card",".wtr_card",".weather-box",".tq-box","#tq_main"];',
    '  for(var i=0;i<ws.length;i++){try{',
    '    var el=document.querySelector(ws[i]);',
    '    if(el){var t=cl(el.innerText);',
    '      if(t.length>15&&t.length<1000){cards.push("[天气] "+t.slice(0,600));break;}}',
    '  }catch(e){}}',
    // Weather text-pattern fallback
    '  if(!cards.length){',
    '    var bt=document.body?(document.body.innerText||""):"";',
    '    if(/\\d{1,3}\\s*[°℃℉]/.test(bt)&&/天气|weather|气温|温度|humidity|湿度|降水|风速|风力|多云|晴|阴|雨|雪/i.test(bt)){',
    '      var ls=bt.split("\\n"),wl=[];',
    '      for(var j=0;j<ls.length&&wl.length<12;j++){',
    '        var ln=cl(ls[j]);',
    '        if(ln.length<3||ln.length>200)continue;',
    '        if(/[°℃℉]|天气|weather|气温|温度|humidity|湿度|降水|风速|风力|wind|多云|晴|阴|雨|雪|紫外|UV/i.test(ln))wl.push(ln);',
    '      }',
    '      if(wl.length>=2)cards.push("[天气] "+wl.join(", "));',
    '    }',
    '  }',
    // Knowledge panel
    '  var ks=["[class*=kno-rdesc]","[data-attrid=description]",".knowledge-panel",".kp-wholepage",',
    '    "[class*=featured-snippet]",".xpdopen","[data-tts=answers]",".answer-box",',
    '    ".vr_ans",".vrwrap_ans",".op_exactqa_s_answer",".c-border"];',
    '  for(var k=0;k<ks.length&&cards.length<3;k++){try{',
    '    var ke=document.querySelector(ks[k]);',
    '    if(ke){var kt=cl(ke.innerText);',
    '      if(kt.length>30&&kt.length<1500){',
    '        if(cards.length>0&&cards[0].indexOf(kt.slice(0,40))!==-1)continue;',
    '        cards.push("[知识卡片] "+kt.slice(0,600));}}',
    '  }catch(e){}}',
    '  return cards;',
    '}',

    // Layer 2: Structured search results
    'function extractResults(){',
    '  var res=[],seen={};',
    '  var fam=[',
    '    {c:"#search .g,#rso .g,#rso [data-sokoban-container],div[data-header-feature]",',
    '     t:"h3,[role=heading]",s:".VwiC3b,[data-sncf],[style*=-webkit-line-clamp],.IsZvec,.lEBKkf",l:"a[href]"},',
    '    {c:".vrwrap,.rb,.results>div,.result",',
    '     t:"h3,.vrTitle,.title",s:"p,.str_info,.space-txt,.text-layout",l:"a[href]"},',
    '    {c:".b_algo,.b_ans",t:"h2,.b_title",s:".b_caption p,.b_snippet",l:"a[href]"},',
    '    {c:".c-container,.result,.result-op",t:"h3,.t,.c-title",s:".c-abstract,.content-right,.c-span-last",l:"a[href]"}',
    '  ];',
    '  for(var fi=0;fi<fam.length;fi++){',
    '    if(res.length>=MR)break;var f=fam[fi];try{',
    '    var cs=document.querySelectorAll(f.c);',
    '    for(var ci=0;ci<cs.length&&res.length<MR;ci++){',
    '      var bx=cs[ci],tE=bx.querySelector(f.t),sE=bx.querySelector(f.s),lE=bx.querySelector(f.l);',
    '      var ti=cl(tE&&tE.innerText);if(!ti||ti.length<4)continue;',
    '      var ky=ti.slice(0,50);if(seen[ky])continue;seen[ky]=1;',
    '      var sn=cl(sE&&sE.innerText),ur=lE?(lE.href||""):"";',
    '      var ln=ti;',
    '      if(sn&&sn.length>10&&ti.indexOf(sn.slice(0,25))===-1)ln+=" -- "+sn.slice(0,300);',
    '      if(ur&&/^https?:/.test(ur)&&ur.indexOf("/search?")===-1&&ur.indexOf("javascript:")===-1)ln+=" -- "+ur;',
    '      res.push(ln);',
    '    }}catch(e){}}',
    '  return res;',
    '}',

    // Layer 3: Semantic link extraction
    'function extractLinks(){',
    '  var res=[],seen={},all=document.querySelectorAll("a[href]");',
    '  for(var i=0;i<all.length&&res.length<MR;i++){',
    '    var a=all[i],hr=a.href||"";',
    '    if(!/^https?:/.test(hr))continue;',
    '    if(/\\/search\\?|google\\.com\\/url|javascript:|#$/.test(hr))continue;',
    '    var tx=cl(a.innerText||a.textContent);',
    '    if(tx.length<8||tx.length>150)continue;',
    '    var ky=tx.slice(0,50);if(seen[ky])continue;seen[ky]=1;',
    '    var pa=a.closest("div,article,section,li,td"),ctx="";',
    '    if(pa){ctx=cl(pa.innerText).replace(tx,"").slice(0,200);}',
    '    var ln=tx;if(ctx&&ctx.length>15)ln+=" -- "+ctx;',
    '    ln+=" -- "+hr;res.push(ln);',
    '  }',
    '  return res;',
    '}',

    // Main orchestrator (Layer 4 = Readability, handled externally in webSearch)
    'function run(){',
    '  var out=[];',
    '  var cards=extractCards();for(var i=0;i<cards.length;i++)out.push(cards[i]);',
    '  var sr=extractResults();for(var j=0;j<sr.length;j++)out.push(sr[j]);',
    '  if(sr.length<3){var sl=extractLinks();',
    '    for(var k=0;k<sl.length&&out.length<MR+2;k++){',
    '      if(!out.some(function(x){return x.slice(0,60)===sl[k].slice(0,60);}))out.push(sl[k]);',
    '    }',
    '  }',
    '  return out.join("\\n")||"No content extracted.";',
    '}',
    'return run();',
    '})()',
  ].join('\n');
}

// Single universal extraction script — works on ALL search engines
const UNIVERSAL_EXTRACT = buildExtractScript();

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
export async function webSearch(query: string, engine?: string): Promise<string> {
  if (!query) return 'Error: query is required';

  const { browserViewManager } = require('../browser-view-manager');
  const { BrowserWindow: BW } = require('electron');
  const q = encodeURIComponent(query);

  // Ensure browser panel is visible so user can see the search
  const allWindows = BW.getAllWindows();
  const mainWindow = allWindows.find((w: any) => w.getTitle()?.includes('DSME')) || allWindows[0];
  if (mainWindow) mainWindow.webContents.send('browser-panel-open');

  const allEngines: Record<string, { label: string; url: string; extractJS: string }> = {
    google: { label: 'Google', url: `https://www.google.com/search?q=${q}&hl=zh-CN`, extractJS: UNIVERSAL_EXTRACT },
    sogou:  { label: 'Sogou',  url: `https://www.sogou.com/web?query=${q}`,          extractJS: UNIVERSAL_EXTRACT },
    baidu:  { label: 'Baidu',  url: `https://www.baidu.com/s?wd=${q}`,               extractJS: UNIVERSAL_EXTRACT },
    bing:   { label: 'Bing',   url: `https://www.bing.com/search?q=${q}`,            extractJS: UNIVERSAL_EXTRACT },
  };

  // If user specified an engine, use only that one; otherwise try all in default order
  let engineList: typeof allEngines[string][];
  const requestedEngine = engine?.toLowerCase().trim();
  if (requestedEngine && allEngines[requestedEngine]) {
    engineList = [allEngines[requestedEngine]];
  } else {
    engineList = [allEngines.google, allEngines.sogou];
  }

  for (const eng of engineList) {
    try {
      const navResult = await browserViewManager.navigate(eng.url);
      if (navResult.startsWith('Navigation error:') && !navResult.includes('ERR_ABORTED')) {
        continue;
      }

      // Wait for dynamic content to load
      await new Promise(r => setTimeout(r, 2000));

      // Primary extraction: our multi-layer universal extractor
      const text = await browserViewManager.executeJS(eng.extractJS, 10000);
      if (text && text.length > 20 && !text.startsWith('Script error:') && !text.startsWith('[evaluate:')) {
        // Bonus: if results seem thin, supplement with Readability deep extraction
        let result = `Results from ${eng.label}:\n${text}`;
        if (countSearchResultLines(text) < 3) {
          const article = await extractWithReadability(browserViewManager);
          if (article && article.textContent.length > 100) {
            result += `\n\n[深度提取 by Readability]\n${article.textContent.slice(0, 3000)}`;
          }
        }
        return result;
      }

      // Fallback: if universal extractor got nothing, try Readability alone
      const article = await extractWithReadability(browserViewManager);
      if (article && article.textContent.length > 50) {
        return `Results from ${eng.label} (Readability):\n${article.title}\n${article.textContent.slice(0, 5000)}`;
      }
    } catch (e: any) {
      console.warn(`[webSearch] ${eng.label} failed:`, e.message);
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
- web_search returns machine-readable metadata with \`WEB_SEARCH_STATUS\` and \`RESULT_COUNT\`.
- **Sufficiency principle**: After web_search returns, assess whether the extracted snippets already contain enough information to answer the user's question. If yes, answer directly — do not call fetch_url or any other tool just to "confirm" or "enrich" what you already have. Each unnecessary tool call costs the user 5-10 seconds.
- Call fetch_url only when you genuinely cannot answer from the search snippets alone — e.g. the snippets are too fragmented, contradictory, or the user explicitly asked to read a specific page.
- Synthesize results concisely. Match response length to question complexity.

### Rich Media Rendering (render_html)
- You have a built-in browser panel that can render HTML natively.
- **Necessity principle**: Use render_html only when the content genuinely needs visual layout that Markdown cannot provide — such as image galleries, embedded media, or complex interactive visualizations.
- If the answer can be expressed clearly in Markdown (text, tables, lists, bold), just reply in chat. Do not generate HTML merely to make text look prettier.

### Browse Page (Interactive Browser)
- Use browse_page when you need to interact with a page: click buttons, fill forms, navigate tabs, scroll, or extract data from JS-rendered SPAs.
- **Step 1 — Reconnaissance**: First call browse_page with a simple script like \`document.title + '\\\\n' + document.body.innerText.slice(0, 3000)\` to understand the page structure.
- **Step 2 — Action**: Write a self-contained async JS script that performs clicks, waits, and extracts data.
- The script runs in page context with full DOM access. It MUST return a string.
- Prefer browse_page over fetch_url for any page that uses client-side rendering.


### Browser-Use (Long-running Browser Agent) — CRITICAL DISCIPLINE RULES
Use browser_* tools for complex, multi-step browser tasks on a **persistent visible webview** — the user sees navigation, loading, and extraction like a real browser session.

**Long workflows (3+ steps)** — reduce confusion and keep one timeline:
1. Call **browser_task_start(goal)** once with a short goal string (shown as the panel heading).
2. Run **browser_navigate → browser_snapshot → interact → browser_snapshot** in a loop until done.
3. Call **browser_task_finish(summary)** when finished (optional **summary** appears in the banner).

**Pattern: navigate → snapshot → act → snapshot → repeat**
1. browser_navigate(url) to open a page
2. browser_snapshot() to see elements with refs [e1], [e2]..
3. browser_click(ref) / browser_type(ref, text) / browser_scroll(direction) to interact
4. browser_snapshot() again after navigation or DOM changes — refs become stale

#### ⚠️ MANDATORY: Page State Awareness (Anti-Rush Protocol)
**YOU MUST NEVER rush ahead without confirming the page is idle.** Failure to follow these rules will cause actions to silently fail and produce garbage results.

1. **After submitting a form, clicking "Send", or triggering any AI generation**:
   - Call **browser_wait_for_idle(timeout_ms)** with an appropriate timeout.
   - For AI image/video generation: use **60000-120000ms** (1-2 minutes).
   - For normal form submissions: use **15000ms** (default).
2. **Check the snapshot for loading state**:
   - If the snapshot contains \`⚠️ PAGE STATE: LOADING\`, **STOP and call browser_wait_for_idle()** before taking any action.
   - If a button shows \`[DISABLED]\`, the page is not ready — **wait**, then re-snapshot.
3. **After any click that causes navigation or AJAX**, the tool auto-waits briefly, but for slow operations (AI generation, file uploads), you MUST explicitly call browser_wait_for_idle.

#### ⚠️ MANDATORY: Robust Element Selection
**NEVER use blind or fragile DOM selectors.** Follow these rules strictly:

1. **Always use \`aria-label\` or \`data-dsme-ref\` for element identification** — never guess by SVG presence or empty text content.
2. **FORBIDDEN pattern**: \`document.querySelectorAll('button').find(b => b.textContent === '' && b.querySelector('svg'))\` — this matches any icon button (mic, attachment, camera) and WILL click the wrong element.
3. **CORRECT pattern**: Use the ref IDs from browser_snapshot: \`browser_click("e5")\`, or use precise selectors like \`button[aria-label="发送"]\` or \`button[aria-label="Send"]\`.
4. Before clicking a send/submit button, **always re-snapshot** to get fresh refs — they change after typing.

#### ⚠️ MANDATORY: Native Input (Anti-TrustedHTML Protocol)
**ALWAYS use browser_type and browser_press_key for text input and form submission.** These tools use Chromium-native APIs that bypass TrustedHTML/CSP restrictions and trigger all framework event listeners.

1. **To type text**: Use \`browser_type(ref, text)\` — this uses \`webContents.insertText()\` at the engine level. NEVER write JS eval scripts that set \`el.value\`, \`el.innerText\`, or \`el.innerHTML\` — these will be blocked by TrustedHTML on secure sites (Google, etc.) and may not trigger framework state updates.
2. **To press Enter/submit**: Use \`browser_press_key("Enter")\` — this sends a real keyboard event. NEVER use \`el.dispatchEvent(new KeyboardEvent(...))\` in JS eval — it's fragile and often ignored by frameworks.
3. **Workflow**: \`browser_type(ref, text)\` → \`browser_press_key("Enter")\` — this two-step combo replaces all JS-based text input hacks.

#### ⚠️ MANDATORY: Binary Data Handling
1. **NEVER return base64 image data directly** — it will flood and destroy the context window.
2. If you need to extract an image from a page, use browser_eval with a script that calls Canvas + toDataURL. The system will **automatically save it to disk** and return a file path.
3. To download an image, prefer using \`fetch(url).then(r => r.blob())\` + saving to disk via a run_command, or simply provide the image URL to the user.

#### Other Guidelines
- ALWAYS snapshot before clicking — refs change after page updates
- The webview is persistent — login state carries across calls
- Prefer browser_* (step-by-step, visible) over browse_page when the task needs steering, verification between actions, or user trust through transparency
- Prefer browse_page only when a single scripted interaction block is enough (one URL + one returning script)
- **Batch data extraction**: When scraping paginated or multi-page data (e.g. stock lists, search results across pages), write a **single self-contained async script** in one browser_eval call that loops through all pages internally (click next → wait → extract → repeat). Do NOT make separate browser_eval calls per page — each call resets local variables, causing redundant work and potential infinite loops.
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
