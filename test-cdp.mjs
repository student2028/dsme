// CDP test: switch to vercel kernel, send a message, wait for response
import WebSocket from 'ws';

const WS_URL = process.argv[2] || 'ws://127.0.0.1:19222/devtools/page/66AF26CFDC651CC9708223B103767426';
let id = 1;

function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = id++;
    ws.send(JSON.stringify({ id: msgId, method, params }));
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === msgId) {
        ws.removeListener('message', handler);
        resolve(msg.result);
      }
    };
    ws.on('message', handler);
    setTimeout(() => reject(new Error('timeout')), 30000);
  });
}

async function evaluate(ws, expression) {
  const result = await send(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result?.result?.value;
}

async function main() {
  const ws = new WebSocket(WS_URL);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  console.log('[CDP] Connected');

  // Step 1: Check current kernel and switch to vercel if needed
  const currentKernel = await evaluate(ws, `
    (async () => {
      const config = await window.electronAPI.getConfig();
      return config.agentKernel || 'builtin';
    })()
  `);
  console.log('[CDP] Current kernel:', currentKernel);

  if (currentKernel !== 'vercel') {
    console.log('[CDP] Switching to Vercel kernel...');
    await evaluate(ws, `
      (async () => {
        const config = await window.electronAPI.getConfig();
        await window.electronAPI.saveConfig({ ...config, agentKernel: 'vercel' });
        window.electronAPI.relaunchApp();
        return 'done';
      })()
    `);
    // Wait for agent to reinitialize
    await new Promise(r => setTimeout(r, 2000));
    console.log('[CDP] Kernel switched');
  }

  // Step 2: Send a simple chat message
  console.log('[CDP] Sending test message: "你好"');
  await evaluate(ws, `window.electronAPI.sendChatMessage('你好')`);

  // Step 3: Wait and poll for response
  console.log('[CDP] Waiting for AI response...');
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const state = await evaluate(ws, `
      (() => {
        const msgs = document.querySelectorAll('.message-bubble');
        const last = msgs[msgs.length - 1];
        const status = document.querySelector('.agent-status-badge');
        return JSON.stringify({
          msgCount: msgs.length,
          lastMsg: last ? last.textContent?.slice(0, 200) : '',
          lastRole: last?.closest('.message')?.classList?.contains('assistant') ? 'assistant' : 'user',
          status: status ? status.textContent : 'idle'
        });
      })()
    `);
    const parsed = JSON.parse(state || '{}');
    process.stdout.write(`  [${i+1}s] msgs=${parsed.msgCount} status=${parsed.status}\r`);
    
    // Check if AI finished responding
    if (parsed.msgCount >= 2 && !parsed.status) {
      console.log('\n[CDP] AI responded!');
      console.log('[CDP] Last message:', parsed.lastMsg);
      break;
    }
    if (i === 29) {
      console.log('\n[CDP] Timeout. Last state:', parsed);
    }
  }

  // Get final chat content
  const chatContent = await evaluate(ws, `
    (() => {
      const msgs = document.querySelectorAll('.message');
      return Array.from(msgs).slice(-3).map(m => {
        const role = m.classList.contains('assistant') ? 'AI' : 'USER';
        const text = m.querySelector('.message-bubble')?.textContent?.slice(0, 300) || '';
        return role + ': ' + text;
      }).join('\\n');
    })()
  `);
  console.log('\n[CDP] Chat log:\n' + chatContent);

  ws.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
