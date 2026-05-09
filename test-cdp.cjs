const http = require('http');
const WS = require('ws');

async function main() {
  const pages = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:19222/json', res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  const page = pages.find(p => p.url.includes('5173'));
  if (!page) { console.log('No page found'); process.exit(1); }
  
  const ws = new WS(page.webSocketDebuggerUrl);
  await new Promise(r => ws.on('open', r));
  
  let msgId = 1;
  function ev(expr) {
    return new Promise((resolve) => {
      const id = msgId++;
      ws.send(JSON.stringify({id, method:'Runtime.evaluate', params:{expression:expr, returnByValue:true, awaitPromise:true}}));
      const h = raw => { const m=JSON.parse(raw.toString()); if(m.id===id) { ws.removeListener('message',h); resolve(m.result?.result?.value); }};
      ws.on('message', h);
    });
  }

  console.log('Sending: 禹州明天天气');
  await ev(`window.electronAPI.sendChatMessage('禹州明天天气')`);

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const s = await ev(`(()=>{const a=document.querySelectorAll('.chat-message.assistant .md-content');const l=a[a.length-1];return JSON.stringify({c:a.length,t:l?l.innerText.slice(0,500):''});})()`);
    const p = JSON.parse(s || '{}');
    const t = p.t.replace(/\n/g,' ').slice(0,80);
    console.log(`[${String(i+1).padStart(2)}s] ai=${p.c} ${t}`);
    if (p.c >= 2 && p.t.length > 30 && !p.t.startsWith('New session') && !p.t.startsWith('Agent kernel')) {
      console.log('\n===== WEATHER TEST PASSED =====');
      console.log(p.t);
      ws.close(); process.exit(0);
    }
  }
  console.log('TIMEOUT');
  ws.close(); process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
