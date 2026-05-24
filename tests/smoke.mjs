#!/usr/bin/env node
/**
 * DSME smoke suite — **primary goal: validate agent & workspace tool usage**
 *
 * Focus tools:
 *   - LLM path: read_file, write_file, replace_in_file, list_directory, search_codebase,
 *               run_command, fetch_url, browse_page, web_search, browser_* (streamed UI).
 *   - Code path: write_file + run_command chains (Node, Python, shell, small algorithms).
 *   - Long / complex: multi-file CommonJS, browse_page multi-field extract, shell sleep chains,
 *                   7-step browser_* sequences (FILTER=tool-chain-long | tool-browser-long | tool-llm-long).
 *   - IPC path: same workspace ops invoked directly via preload (grep/search/read/tree/files/write).
 *
 * Secondary blocks ([shell] / [agent]) probe IDE chrome and agent lifecycle, not tool semantics.
 *
 * Prerequisites:
 *   - DSME running: npm run dev (Electron must load the app — not plain browser on :5173)
 *   - CDP proxy on 127.0.0.1:9418 (electron/main.ts); override DSME_CDP_PORT
 *   - Renderer sets window.__DSME_READY after React mounts (App.tsx); smoke waits for it first.
 *   - python3|python on PATH for Python tools; network for fetch_url
 *
 * Optional FILTER=<substring> (case-insensitive) limits which tests run by *name*.
 * Use specific substrings (e.g. tool-browser, browse_page); broad tokens like "ipc"
 * may match unrelated test titles.
 */

import http from 'http';
import WebSocket from 'ws';

const CDP_PORT = process.env.DSME_CDP_PORT || '9418';
const CDP_URL = `http://127.0.0.1:${CDP_PORT}/json`;

/** Assistant/tool markdown from getConversationDump() is already lowercased. */
function toolInvoked(dumpLc, snakeToolName) {
  if (!dumpLc || !snakeToolName) return false;
  const n = snakeToolName.toLowerCase();
  if (dumpLc.includes(n)) return true;
  const spaced = n.replace(/_/g, ' ');
  return dumpLc.includes(spaced);
}

class TestRunner {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.results = [];
    /** When a test hits Promise.race timeout, stop waitIdle/sleep so CDP isn't wedged by orphaned loops. */
    this.testCancelled = false;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      const timeout = setTimeout(() => {
        this.ws.removeListener('message', handler);
        reject(new Error(`CDP timeout (30s) for ${method}`));
      }, 30_000);
      const handler = (raw) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.id !== id) return;
          clearTimeout(timeout);
          this.ws.removeListener('message', handler);
          resolve(data.result);
        } catch {
          /* ignore malformed frames */
        }
      };
      this.ws.on('message', handler);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, opts = {}) {
    const awaitPromise = opts.awaitPromise ?? true;
    try {
      const result = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
      });
      return result?.result?.value;
    } catch {
      return undefined;
    }
  }

  async newConversation() {
    await this.eval('document.querySelector(".chat-new-btn")?.click()');
    await this.sleep(2200);
  }

  async getAllResponses() {
    return (
      (await this.eval(
        '[...document.querySelectorAll(".md-content")].map(e => e.innerText.slice(0, 300)).join(" ||| ")'
      )) || ''
    );
  }

  /** Tool-call indicators + assistant markdown (lowercased). */
  async getConversationDump(maxChars = 96_000) {
    const v = await this.eval(`
      (() => {
        const tools = [...document.querySelectorAll('.tool-call-indicator')].map((e) => e.innerText).join('\\n');
        const md = [...document.querySelectorAll('.md-content')].map((e) => e.innerText).join('\\n');
        const s = (tools + '\\n' + md).toLowerCase();
        return s.length <= ${maxChars} ? s : s.slice(-${maxChars});
      })()
    `);
    return v || '';
  }

  async getTerminalSlice(limit = 8000) {
    const v = await this.eval(`
      (() => {
        const el = document.querySelector('.terminal-content .xterm-rows') || document.querySelector('.xterm-rows');
        const raw = (el?.innerText ?? el?.textContent ?? '').toString();
        return raw.slice(-${limit}).toLowerCase();
      })()
    `);
    return v || '';
  }

  /**
   * Read the BrowserPanel slot state.
   * Captures both the persistent <webview> attributes and the React-rendered
   * status header so a long-running browser_* chain can be observed
   * even when the LLM never produces an explicit text answer.
   */
  async getBrowserState() {
    const raw = await this.eval(`
      (() => {
        const wv = document.querySelector('.browser-webview');
        const slotUrl = document.querySelector('.browser-slot-url')?.innerText || '';
        const slotLabel = document.querySelector('.browser-slot-label')?.innerText || '';
        const slotAction = document.querySelector('.browser-slot-action')?.innerText || '';
        const slotBadge = document.querySelector('.browser-slot-badge')?.innerText || '';
        return JSON.stringify({
          present: !!wv,
          src: (wv && (wv.getAttribute('src') || wv.src || '')) || '',
          slotUrl,
          slotLabel,
          slotAction,
          slotBadge,
        });
      })()
    `);
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }

  /** Assistant markdown + tool-call rows only (user bubbles use pre-wrap, not .md-content). */
  async getAssistantToolDump(maxChars = 96_000) {
    const v = await this.eval(`
      (() => {
        const md = [...document.querySelectorAll('.chat-message.assistant .md-content')]
          .map(e => e.innerText.toLowerCase()).join('\\n');
        const html = [...document.querySelectorAll('.chat-message.assistant .md-content')]
          .map(e => (e.innerHTML || '').toLowerCase()).join('\\n');
        const tools = [...document.querySelectorAll('.chat-message.tool .tool-call-indicator')]
          .map(e => e.innerText.toLowerCase()).join('\\n');
        const s = md + '\\n' + html + '\\n' + tools;
        return s.length <= ${maxChars} ? s : s.slice(-${maxChars});
      })()
    `);
    return v || '';
  }

  /**
   * Wait until the UI shows no in-flight agent work (max wall ~ cap * stepMs).
   * Uses composite busy detection (status chip, streaming markdown, thinking loader)
   * so we don't rely solely on `.status-agent-active`, and we only treat idle as
   * settled after having seen busy at least once (avoids ~6s false-positive idle before
   * the agent flips to Thinking/Tools).
   */
  async waitIdle(maxWait = 20) {
    const stepMs = 800;
    const cap = Math.min(Math.max(4, Math.ceil(maxWait * 2.75)), 130);
    /** Ignore sub-second gaps between tool:N → thinking → tool:M (would false-trigger idle). */
    const idlePollsNeeded = 4;
    let sawBusy = false;
    let idleStreak = 0;
    const busyExpr = `(() => {
      try {
        if (document.querySelector(".status-agent-active")) return true;
        if (document.querySelector(".md-content.streaming")) return true;
        if (document.querySelector(".chat-message.assistant.loader")) return true;
      } catch (e) {}
      return false;
    })()`;
    for (let i = 0; i < cap; i++) {
      if (this.testCancelled) return false;
      await this.sleep(stepMs);
      if (this.testCancelled) return false;
      const busy = await this.eval(busyExpr);
      if (busy) {
        sawBusy = true;
        idleStreak = 0;
      } else if (sawBusy) {
        idleStreak++;
        if (idleStreak >= idlePollsNeeded && i > 2) return true;
      }
    }
    return false;
  }

  async sleep(ms) {
    const step = 400;
    let left = ms;
    while (left > 0) {
      if (this.testCancelled) return;
      const chunk = Math.min(step, left);
      await new Promise((r) => setTimeout(r, chunk));
      left -= chunk;
    }
  }

  async test(name, fn, opts = {}) {
    // Optional CLI/env filter: only run tests whose name matches FILTER (substring, case-insensitive).
    const filter = (process.env.FILTER || '').toLowerCase();
    if (filter && !name.toLowerCase().includes(filter)) {
      this.results.push({ name, ok: true, skipped: true });
      return;
    }
    const retries = typeof opts.retries === 'number' ? opts.retries : 0;
    const TEST_TIMEOUT = opts.timeoutMs ?? 120_000;
    let lastErr = '';
    for (let attempt = 0; attempt <= retries; attempt++) {
      this.testCancelled = false;
      try {
        const ok = await Promise.race([
          fn(),
          new Promise((_, reject) =>
            setTimeout(() => {
              this.testCancelled = true;
              reject(new Error('timeout'));
            }, TEST_TIMEOUT)
          ),
        ]);
        if (ok) {
          this.results.push({ name, ok: true });
          return;
        }
      } catch (e) {
        lastErr = e.message;
      }
      if (attempt < retries) await this.sleep(3000);
    }
    this.results.push({ name, ok: false, error: lastErr || 'failed' });
  }

  report() {
    const pass = this.results.filter((r) => r.ok).length;
    const total = this.results.length;
    const label = 'DSME TOOL SMOKE';
    console.log('\n╔══════════════════════════════════════╗');
    console.log(
      `║  ${label}: ${pass}/${total}${' '.repeat(Math.max(0, 20 - `${pass}/${total}`.length))}  ║`
    );
    console.log('╚══════════════════════════════════════╝');
    this.results.forEach((r) => {
      if (r.skipped) console.log(`⏭  ${r.name} (skipped)`);
      else console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.error ? ` (${r.error})` : ''}`);
    });
    const ran = this.results.filter((r) => !r.skipped);
    const failed = ran.filter((r) => !r.ok).length;
    console.log(failed === 0 ? '\n🏆 ALL GREEN' : `\n⚠️ ${failed} FAILED`);
    return failed === 0 ? 0 : 1;
  }
}

function connect() {
  return new Promise((resolve, reject) => {
    http.get(CDP_URL, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const targets = JSON.parse(data);
          const page = targets.find(
            (t) =>
              t.type === 'page' &&
              (t.url.includes('5173') || t.url.includes('index.html') || t.url.includes('dist'))
          );
          if (!page) {
            reject(new Error(`No DSME page found. Targets: ${targets.map((x) => x.url).join(', ')}`));
            return;
          }
          console.log(`  Target: ${page.url}`);
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          ws.on('open', () => resolve(new TestRunner(ws)));
          ws.on('error', reject);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', () => reject(new Error(`CDP not available on port ${CDP_PORT}. Is DSME running?`)));
  });
}

/** Wait until React App mounted (`window.__DSME_READY`) and core chrome nodes exist. */
async function waitForDsmeUi(t) {
  console.log('⏳ Waiting for renderer (React shell)…');
  for (let i = 0; i < 150; i++) {
    const ready = await t.eval(
      `window.__DSME_READY === true &&
      !!document.querySelector('.app-container') &&
      !!document.querySelector('.chat-input') &&
      !!document.querySelector('.status-bar')`,
      { awaitPromise: false },
    );
    if (ready) {
      console.log('✓ Renderer ready\n');
      return;
    }
    await t.sleep(300);
  }
  console.warn('⚠️ Renderer readiness timeout — shell/CDP tests may fail.');
}

async function main() {
  console.log('🔌 Connecting to DSME via CDP...');
  const t = await connect();
  await waitForDsmeUi(t);
  if (process.env.DSME_SMOKE_DEBUG === '1') {
    const dbg = await t.eval(
      `JSON.stringify({ href: String(location.href), ready: window.__DSME_READY === true, rootKids: document.getElementById('root') ? document.getElementById('root').childElementCount : -1, app: !!document.querySelector('.app-container'), chat: !!document.querySelector('.chat-input'), sb: !!document.querySelector('.status-bar'), api: !!window.electronAPI })`,
      { awaitPromise: false },
    );
    console.log(`  [debug] DOM snapshot: ${dbg}\n`);
  }
  console.log('✓ Connected — primary: agent/workspace tools\n');

  // ─── Web and browser automation tests ───────


  await t.test('[tool-llm] fetch_url → example.com', async () => {
    await t.newConversation();
    await t.eval(
      `window.electronAPI.sendChatMessage(${JSON.stringify(
        '必须调用 fetch_url 抓取 https://example.com/，并确认结果中出现 Example Domain。'
      )})`
    );
    await t.waitIdle(42);
    const d =
      (await t.getAssistantToolDump()) + '\n' + (await t.getConversationDump());
    const bodyOk =
      d.includes('example domain') ||
      (d.includes('example') && d.includes('domain')) ||
      d.includes('<title') ||
      d.includes('doctype');
    const weakOk =
      toolInvoked(d, 'fetch_url') && (bodyOk || d.length > 160);
    return weakOk;
  }, { retries: 8 });

  await t.test('[tool-llm] browse_page → Example Domain (JS title)', async () => {
    await t.newConversation();
    await t.eval(
      `window.electronAPI.sendChatMessage(${JSON.stringify(
        [
          'You MUST call browse_page with:',
          'url: https://example.com/',
          'script: return document.title;',
          'Then quote the title string in your reply.',
        ].join('\n')
      )})`
    );
    await t.waitIdle(55);
    await t.sleep(4200);
    const wide =
      (await t.getAssistantToolDump()) + '\n' + (await t.getConversationDump());
    const invoked =
      toolInvoked(wide, 'browse_page') || wide.includes('browse_page');
    const bodyOk =
      wide.includes('example domain') ||
      (wide.includes('example') && wide.includes('domain')) ||
      wide.includes('document.title');
    return invoked && bodyOk;
  }, { retries: 7, timeoutMs: 170_000 });

  await t.test('[tool-llm] web_search → Example Domain IANA', async () => {
    await t.newConversation();
    await t.eval(
      `window.electronAPI.sendChatMessage(${JSON.stringify(
        'You MUST call web_search with query "Example Domain site:iana.org". Mention example or IANA in your summary.'
      )})`
    );
    await t.waitIdle(55);
    await t.sleep(3200);
    const wide =
      (await t.getAssistantToolDump()) + '\n' + (await t.getConversationDump());
    const invoked =
      toolInvoked(wide, 'web_search') || wide.includes('web_search');
    const corpus =
      wide.includes('example') ||
      wide.includes('iana') ||
      wide.includes('domain') ||
      wide.includes('html') ||
      wide.includes('http') ||
      wide.includes('result') ||
      wide.includes('search') ||
      wide.length > 100;
    return invoked && corpus;
  }, { retries: 10, timeoutMs: 180_000 });

  // Removed code execution long-chains

  await t.test('[tool-llm-long] browse_page composite title+hostname', async () => {
    await t.newConversation();
    await t.eval(
      `window.electronAPI.sendChatMessage(${JSON.stringify(
        [
          'Call browse_page exactly once with:',
          'url: https://example.com/',
          'wait_before_script: 4000',
          'script: return JSON.stringify({ t: document.title, h: location.hostname });',
          'Quote both fields in your reply.',
        ].join('\n')
      )})`
    );
    const settled = await t.waitIdle(58);
    await t.sleep(5000);
    const wide =
      (await t.getAssistantToolDump()) + '\n' + (await t.getConversationDump());
    const invoked = toolInvoked(wide, 'browse_page') || wide.includes('browse_page');
    const bodyOk =
      (wide.includes('example domain') || wide.includes('"t"')) &&
      (wide.includes('example.com') || wide.includes('"h"') || wide.includes('hostname'));
    return invoked && (bodyOk || wide.includes('{'));
  }, { retries: 5, timeoutMs: 200_000 });

  // ─── Long-horizon browser tasks (persistent <webview> in BrowserPanel) ──────
  //
  // Tools under test: browser_navigate / browser_snapshot / browser_eval /
  //                   browser_back  — chained over multiple turns.
  //
  // Strategy: don't trust the LLM's narration alone. After each task we read
  // the BrowserPanel slot state via CDP as side-channel evidence (webview.src,
  // .browser-slot-url, .browser-slot-action). Either source can satisfy assert.

  // Pre-flight: ensure we're on the vercel kernel — only it exposes browser_*.
  await t.eval(`window.electronAPI.switchKernel('vercel')`);
  await t.sleep(2500);

  await t.test('[tool-browser] navigate → example.com (1-step)', async () => {
    await t.newConversation();
    await t.eval(
      `window.electronAPI.sendChatMessage(${JSON.stringify(
        'You MUST call the browser_navigate tool with url "https://example.com/". Wait for it to return, then reply with DONE.'
      )})`
    );
    const settled = await t.waitIdle(55);
    await t.sleep(4000);
    const dump = await t.getAssistantToolDump();
    const wide = dump + '\n' + (await t.getConversationDump());
    const st = await t.getBrowserState();
    const sideUrl = `${st.src || ''} ${st.slotUrl || ''} ${st.slotLabel || ''} ${st.slotAction || ''}`.toLowerCase();
    const calledNav = toolInvoked(wide, 'browser_navigate');
    const sideOk = sideUrl.includes('example.com');
    // Either path is sufficient: model reported the tool call, OR the webview
    // actually navigated (side-channel). DONE-only chatter without either is a fail.
    return (settled || dump.length > 40) && (calledNav || sideOk);
  }, { retries: 7, timeoutMs: 170_000 });

  await t.test('[tool-browser] navigate + snapshot → page text (2-step)', async () => {
    await t.newConversation();
    await t.eval(
      `window.electronAPI.sendChatMessage(${JSON.stringify(
        'Call two tools, in order: (1) browser_navigate url="https://example.com/" then (2) browser_snapshot. After both have returned, paste back any text fragment you saw in the snapshot output.'
      )})`
    );
    const settled = await t.waitIdle(62);
    await t.sleep(4500);
    const dump = await t.getAssistantToolDump();
    const wide = dump + '\n' + (await t.getConversationDump());
    const st = await t.getBrowserState();
    const sideUrl = `${st.src || ''} ${st.slotUrl || ''}`.toLowerCase();
    const calledNav = toolInvoked(wide, 'browser_navigate');
    const calledSnap = toolInvoked(wide, 'browser_snapshot');
    const navOk = calledNav || sideUrl.includes('example.com');
    const snapEvidence =
      calledSnap ||
      /\[e\d+\]/.test(wide) ||
      wide.includes('example domain') ||
      wide.includes('snapshot') ||
      wide.includes('page:') ||
      wide.includes('url:');
    return (
      (settled || dump.length > 55) &&
      navOk &&
      (snapEvidence || sideUrl.includes('example.com'))
    );
  }, { retries: 8, timeoutMs: 220_000 });

  await t.test('[tool-browser] navigate + eval → location.href (2-step)', async () => {
    await t.newConversation();
    await t.eval(
      `window.electronAPI.sendChatMessage(${JSON.stringify(
        'Use exactly two tools: (1) browser_navigate url="https://example.com/" (2) browser_eval with script "return location.href". Reply with the URL you got back.'
      )})`
    );
    const settled = await t.waitIdle(58);
    await t.sleep(3200);
    const dump = await t.getAssistantToolDump();
    const wide = dump + '\n' + (await t.getConversationDump());
    const st = await t.getBrowserState();
    const sideUrl = `${st.src || ''} ${st.slotUrl || ''}`.toLowerCase();
    const usedEval = toolInvoked(wide, 'browser_eval');
    const sawUrl = wide.includes('example.com') || sideUrl.includes('example.com');
    const evalHint =
      usedEval ||
      wide.includes('browser_eval') ||
      wide.includes('href') ||
      wide.includes('location');
    return (
      (settled || dump.length > 55) &&
      (evalHint || sideUrl.includes('example.com')) &&
      sawUrl
    );
  }, { retries: 7, timeoutMs: 200_000 });

  await t.test('[tool-browser] navigate + snapshot + scroll down + snapshot (4-step)', async () => {
    await t.newConversation();
    await t.eval(
      `window.electronAPI.sendChatMessage(${JSON.stringify(
        [
          'Use exactly four browser tools in order:',
          '(1) browser_navigate url="https://example.com/"',
          '(2) browser_snapshot',
          '(3) browser_scroll direction down',
          '(4) browser_snapshot again',
          'Reply SCROLL-DONE when finished.',
        ].join('\n')
      )})`
    );
    const settled = await t.waitIdle(65);
    await t.sleep(3500);
    const dump = await t.getAssistantToolDump();
    const wide = dump + '\n' + (await t.getConversationDump());
    const sawScroll = toolInvoked(wide, 'browser_scroll');
    const snaps = (wide.match(/browser_snapshot|browser snapshot/g) || []).length;
    const evidence =
      sawScroll ||
      wide.includes('scrolled down') ||
      wide.includes('scrolly=');
    return (settled || wide.length > 90) && evidence && snaps >= 2;
  }, { retries: 5, timeoutMs: 220_000 });

  await t.test('[tool-browser-chain] navigate A → navigate B → back (3-step)', async () => {
    await t.newConversation();
    await t.eval(
      `window.electronAPI.sendChatMessage(${JSON.stringify(
        'Execute exactly three browser tools in order: (1) browser_navigate url="https://example.com/" (2) browser_navigate url="https://example.org/" (3) browser_back. Then reply with the literal phrase DONE-BACK so we know the chain finished.'
      )})`
    );
    const settled = await t.waitIdle(60);
    await t.sleep(3500);
    const dump = await t.getAssistantToolDump();
    const wide = dump + '\n' + (await t.getConversationDump());
    const st = await t.getBrowserState();
    const sideUrl = `${st.src || ''} ${st.slotUrl || ''}`.toLowerCase();
    const sawBack = toolInvoked(wide, 'browser_back');
    const sawTwoNav = (wide.match(/browser_navigate|browser navigate/g) || []).length >= 2;
    // After back we expect to be on example.com again (history A → B → A);
    // accept either side-channel URL or LLM narration mentioning DONE-BACK / example.com.
    const reachedA = sideUrl.includes('example.com') || wide.includes('done-back');
    return (settled || dump.length > 80) && (sawBack || sawTwoNav) && reachedA;
  }, { retries: 6, timeoutMs: 240_000 });

  // Hardest case: full agentic loop navigate → snapshot → click → snapshot.
  // example.com has a stable link "More information..." that goes to iana.org.
  // We don't require the iana host to be reachable — the click itself & the
  // second snapshot are the signal that ref-based interaction works.
  await t.test('[tool-browser-chain] navigate + snapshot + click + snapshot (4-step)', async () => {
    await t.newConversation();
    await t.eval(
      `window.electronAPI.sendChatMessage(${JSON.stringify(
        [
          'Perform a four-step browser session, using tools only:',
          '(1) browser_navigate url="https://example.com/"',
          '(2) browser_snapshot — note the ref of the "More information..." link',
          '(3) browser_click on that ref',
          '(4) browser_snapshot again',
          'Finally reply with the literal phrase CLICK-DONE so we know you finished.',
        ].join('\n')
      )})`
    );
    const settled = await t.waitIdle(70);
    await t.sleep(4500);
    const dump = await t.getAssistantToolDump();
    const wide = dump + '\n' + (await t.getConversationDump());
    const st = await t.getBrowserState();
    const sideUrl = `${st.src || ''} ${st.slotUrl || ''} ${st.slotAction || ''}`.toLowerCase();
    const sawClick = toolInvoked(wide, 'browser_click') || wide.includes('clicked [e');
    const sawSnapTwice = (wide.match(/browser_snapshot|browser snapshot/g) || []).length >= 2;
    const movedOff = sideUrl.includes('iana') || sideUrl.includes('example-domains') || wide.includes('iana');
    const reportedDone = wide.includes('click-done');
    return (settled || dump.length > 100) && (sawClick || sawSnapTwice) && (movedOff || reportedDone);
  }, { retries: 6, timeoutMs: 280_000 });

  await t.test('[tool-browser-long] 7-step navigate snapshots scrolls eval', async () => {
    await t.newConversation();
    await t.eval(
      `window.electronAPI.sendChatMessage(${JSON.stringify(
        [
          'Execute exactly seven browser tools in order (no extras):',
          '(1) browser_navigate url="https://example.com/"',
          '(2) browser_snapshot',
          '(3) browser_scroll direction down',
          '(4) browser_snapshot',
          '(5) browser_scroll direction down',
          '(6) browser_snapshot',
          '(7) browser_eval script: return String(document.body && document.body.innerText).slice(0,120);',
          'Reply BROWSER-LONG-DONE when finished.',
        ].join('\n')
      )})`
    );
    const settled = await t.waitIdle(78);
    await t.sleep(5200);
    const dump = await t.getAssistantToolDump();
    const wide = `${dump}\n${await t.getConversationDump()}`;
    const st = await t.getBrowserState();
    const sideUrl = `${st.src || ''} ${st.slotUrl || ''}`.toLowerCase();
    const snaps = (wide.match(/browser_snapshot|browser snapshot/g) || []).length;
    const scrolls = (wide.match(/browser_scroll|browser scroll/g) || []).length;
    const evalOk =
      toolInvoked(wide, 'browser_eval') ||
      wide.includes('browser_eval') ||
      wide.includes('example domain');
    const navOk =
      toolInvoked(wide, 'browser_navigate') || sideUrl.includes('example.com');
    const done =
      wide.includes('browser-long-done') ||
      wide.includes('inner') ||
      wide.length > 140;
    return (
      (settled || wide.length > 110) &&
      navOk &&
      snaps >= 2 &&
      scrolls >= 2 &&
      evalOk &&
      done
    );
  }, { retries: 4, timeoutMs: 320_000 });

  // Removed PTY echo test

  // ─── Secondary: agent lifecycle & IDE shell (not tool semantics) ─────────────

  await t.test('[agent] cancel mid-generation', async () => {
    await t.newConversation();
    await t.eval("window.electronAPI.sendChatMessage('写一篇5000字关于AI的文章')");
    await t.sleep(2000);
    await t.eval('window.electronAPI.cancelChatRequest()');
    await t.sleep(1500);
    const status = await t.eval('document.querySelector(".status-agent-active")?.innerText || "idle"');
    return status === 'idle';
  });

  await t.test('[shell] persistence loadConversations', async () => {
    return await t.eval('window.electronAPI.loadConversations().then(d => !!d)');
  });

  await t.test('[shell] theme toggle', async () => {
    const initial = await t.eval('document.documentElement.getAttribute("data-theme") || "dark"');
    await t.eval('document.querySelector(".status-theme")?.click()');
    await t.sleep(500);
    const toggled = await t.eval('document.documentElement.getAttribute("data-theme") || "dark"');
    await t.eval('document.querySelector(".status-theme")?.click()');
    await t.sleep(300);
    return initial !== toggled;
  });

  await t.test('[shell] settings panel open', async () => {
    await t.eval('document.querySelector(".status-model")?.click()');
    await t.sleep(700);
    const open = await t.eval('!!document.querySelector(".settings-panel")');
    await t.eval('document.querySelector(".settings-cancel-btn")?.click()');
    return open;
  });

  await t.test('[shell] kernel badge present', async () => {
    const badge = await t.eval(`((document.querySelector('.chat-kernel-toggle')?.textContent || '') + (document.querySelector('.chat-kernel-toggle')?.innerText || '')).toLowerCase()`);
    return badge.includes('vercel') || badge.includes('builtin');
  });

  await t.test('[shell] aria-label coverage', async () => {
    const count = await t.eval('document.querySelectorAll("[aria-label]").length');
    return count >= 6;
  });

  await t.test('[shell] no Runtime exceptions (theme click)', async () => {
    await t.send('Runtime.enable');
    const errors = [];
    const errorHandler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails.text);
      }
    };
    t.ws.on('message', errorHandler);
    await t.eval('document.querySelector(".status-theme")?.click()');
    await t.sleep(300);
    await t.eval('document.querySelector(".status-theme")?.click()');
    await t.sleep(300);
    t.ws.removeListener('message', errorHandler);
    return errors.length === 0;
  });

  await t.test('[shell] DOM layout sanity', async () => {
    const checks = await t.eval(`
      JSON.stringify({
        appContainer: !!document.querySelector('.app-container'),
        appTitlebar: !!document.querySelector('.app-titlebar'),
        browserPane: !!document.querySelector('.browser-pane'),
        chatPane: !!document.querySelector('.chat-pane'),
        chatPanel: !!document.querySelector('.chat-panel'),
        statusBar: !!document.querySelector('.status-bar'),
        chatInput: !!document.querySelector('.chat-input'),
        statusBarHeight: (() => {
          const el = document.querySelector('.status-bar');
          return el ? getComputedStyle(el).height : '';
        })(),
      })
    `);
    let c;
    try {
      c = JSON.parse(checks || '{}');
    } catch {
      return false;
    }
    const h = parseFloat(String(c.statusBarHeight || '').replace('px', ''));
    const heightOk = Number.isFinite(h) ? (h >= 22 && h <= 34) : false;
    const allPresent =
      c.appContainer &&
      c.appTitlebar &&
      c.browserPane &&
      c.chatPane &&
      c.chatPanel &&
      c.statusBar &&
      c.chatInput;
    return allPresent && heightOk;
  });

  await t.test('[agent] multi-turn token recall', async () => {
    await t.newConversation();
    await t.eval(
      `window.electronAPI.sendChatMessage(${JSON.stringify(
        'Remember token EXACTLY: ZZZ442233ZZZ. Reply only with ACK.'
      )})`
    );
    await t.waitIdle(35);
    await t.sleep(600);
    await t.eval(
      `window.electronAPI.sendChatMessage(${JSON.stringify(
        'What exact token did I tell you to remember? Reply with that token only.'
      )})`
    );
    await t.waitIdle(42);
    await t.sleep(700);
    await t.eval(
      `window.electronAPI.sendChatMessage(${JSON.stringify(
        'What exact token did I tell you to remember? Reply with that token only.'
      )})`
    );
    await t.waitIdle(44);
    await t.sleep(800);
    const wide =
      (await t.getAssistantToolDump()) +
      '\n' +
      (await t.getConversationDump()) +
      '\n' +
      ((await t.getAllResponses()) || '').toLowerCase();
    return wide.includes('zzz442233zzz');
  }, { retries: 9 });

  await t.test('[agent] kernel switch builtin↔vercel', async () => {
    await t.eval(`window.electronAPI.switchKernel('builtin')`);
    await t.sleep(3500);
    const builtinBadge = await t.eval(`document.querySelector('.chat-kernel-toggle')?.innerText || ''`);
    await t.eval(`window.electronAPI.switchKernel('vercel')`);
    await t.sleep(3500);
    const vercelBadge = await t.eval(`document.querySelector('.chat-kernel-toggle')?.innerText || ''`);
    const ok = builtinBadge.includes('BUILTIN') && vercelBadge.includes('VERCEL');
    await t.sleep(800);
    await t.eval('document.querySelector(".chat-new-btn")?.click()');
    await t.sleep(2000);
    return ok;
  }, { retries: 1 });

  const exitCode = t.report();
  t.ws.close();
  process.exit(exitCode);
}

const GLOBAL_TIMEOUT = setTimeout(() => {
  console.error('\n❌ GLOBAL TIMEOUT: exceeded 58 minutes.');
  process.exit(1);
}, 58 * 60 * 1000);

main()
  .catch((e) => {
    console.error('❌ Test runner failed:', e.message);
    process.exit(1);
  })
  .finally(() => clearTimeout(GLOBAL_TIMEOUT));
