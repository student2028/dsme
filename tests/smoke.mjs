#!/usr/bin/env node
/**
 * DSME Regression Test Suite
 * 
 * Prerequisites:
 *   - DSME must be running: npm run dev
 *   - CDP enabled on port 19223 (default)
 * 
 * Usage:
 *   node tests/smoke.mjs
 */

import http from 'http';
import WebSocket from 'ws';

const CDP_URL = 'http://127.0.0.1:19223/json';
const TIMEOUT_MS = 30000;

class TestRunner {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.results = [];
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = this.id++;
      this.ws.send(JSON.stringify({ id, method, params }));
      const handler = (raw) => {
        const data = JSON.parse(raw.toString());
        if (data.id === id) {
          this.ws.removeListener('message', handler);
          resolve(data.result);
        }
      };
      this.ws.on('message', handler);
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.result?.value;
  }

  async newConversation() {
    await this.eval('document.querySelector(".chat-new-btn")?.click()');
    await this.sleep(800);
  }

  async getLastResponse() {
    return await this.eval('[...document.querySelectorAll(".md-content")].pop()?.innerText?.slice(0, 500) || ""');
  }

  async waitIdle(maxWait = 20) {
    for (let i = 0; i < maxWait; i++) {
      await this.sleep(2000);
      const status = await this.eval('document.querySelector(".status-agent-active")?.innerText || "idle"');
      if (status === 'idle' && i > 2) return;
    }
  }

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async test(name, fn) {
    try {
      const ok = await fn();
      this.results.push({ name, ok: !!ok });
    } catch (e) {
      this.results.push({ name, ok: false, error: e.message });
    }
  }

  report() {
    const pass = this.results.filter((r) => r.ok).length;
    const total = this.results.length;
    console.log('\n╔══════════════════════════════════════╗');
    console.log(`║  DSME SMOKE TEST: ${pass}/${total}${' '.repeat(16 - `${pass}/${total}`.length)}  ║`);
    console.log('╚══════════════════════════════════════╝');
    this.results.forEach((r) =>
      console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.error ? ` (${r.error})` : ''}`)
    );
    console.log(pass === total ? '\n🏆 ALL GREEN' : `\n⚠️ ${total - pass} FAILED`);
    return pass === total ? 0 : 1;
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
          const page = targets.find((t) => t.url.includes('5173'));
          if (!page) {
            reject(new Error('No DSME page found on port 5173'));
            return;
          }
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          ws.on('open', () => resolve(new TestRunner(ws)));
          ws.on('error', reject);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', () => reject(new Error('CDP not available on port 19223. Is DSME running?')));
  });
}

async function main() {
  console.log('🔌 Connecting to DSME via CDP...');
  const t = await connect();
  console.log('✓ Connected\n');

  // T1: Basic chat
  await t.test('Chat response', async () => {
    await t.newConversation();
    await t.eval("window.electronAPI.sendChatMessage('What is 6*7? Answer only the number.')");
    await t.waitIdle(12);
    const r = await t.getLastResponse();
    return r.includes('42');
  });

  // T2: Tool chain (read file)
  await t.test('Tool chain (read_file)', async () => {
    await t.newConversation();
    await t.eval("window.electronAPI.sendChatMessage('读取 package.json 并告诉我 name 字段的值')");
    await t.waitIdle();
    const r = await t.getLastResponse();
    return r.includes('dsme');
  });

  // T3: Error recovery
  await t.test('Error recovery (file not found)', async () => {
    await t.newConversation();
    await t.eval("window.electronAPI.sendChatMessage('读取文件 /nonexistent_test_42.txt')");
    await t.waitIdle();
    const r = await t.getLastResponse();
    return r.includes('not found') || r.includes('不存在') || r.includes('Error') || r.includes('找不到');
  });

  // T4: Cancel
  await t.test('Cancel request', async () => {
    await t.newConversation();
    await t.eval("window.electronAPI.sendChatMessage('写一篇5000字关于AI的文章')");
    await t.sleep(1500);
    await t.eval('window.electronAPI.cancelChatRequest()');
    await t.sleep(500);
    const status = await t.eval('document.querySelector(".status-agent-active")?.innerText || "idle"');
    return status === 'idle';
  });

  // T5: Persistence
  await t.test('Persistence (save/load)', async () => {
    return await t.eval('window.electronAPI.loadConversations().then(d => !!d)');
  });

  // T6: Theme toggle
  await t.test('Theme toggle', async () => {
    await t.eval('document.querySelector(".status-theme")?.click()');
    await t.sleep(400);
    const isLight = await t.eval('document.documentElement.getAttribute("data-theme") === "light"');
    await t.eval('document.querySelector(".status-theme")?.click()'); // restore
    return isLight;
  });

  // T7: Settings click
  await t.test('Model → Settings click', async () => {
    await t.eval('document.querySelector(".status-model")?.click()');
    await t.sleep(500);
    const open = await t.eval('!!document.querySelector(".settings-panel")');
    await t.eval('document.querySelector(".settings-cancel-btn")?.click()');
    return open;
  });

  // T8: Engine badge
  await t.test('Engine badge (VERCEL)', async () => {
    const badge = await t.eval('document.querySelector(".chat-kernel-toggle")?.innerText || ""');
    return badge.includes('VERCEL');
  });

  // T9: Accessibility
  await t.test('Accessibility (aria-labels)', async () => {
    const count = await t.eval('document.querySelectorAll("[aria-label]").length');
    return count >= 6;
  });

  // T10: Runtime errors
  await t.test('Zero runtime errors', async () => {
    await t.send('Runtime.enable');
    const errors = [];
    const errorHandler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails.text);
      }
    };
    t.ws.on('message', errorHandler);
    // Interact
    await t.eval('document.querySelector(".status-theme")?.click()');
    await t.sleep(300);
    await t.eval('document.querySelector(".status-theme")?.click()');
    await t.sleep(300);
    t.ws.removeListener('message', errorHandler);
    return errors.length === 0;
  });

  const exitCode = t.report();
  t.ws.close();
  process.exit(exitCode);
}

main().catch((e) => {
  console.error('❌ Test runner failed:', e.message);
  process.exit(1);
});
