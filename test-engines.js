#!/usr/bin/env node
/**
 * DSME Engine Stress Test v4
 * Advanced scenarios: multi-tool chains, file write, error handling, context retention.
 * Usage: node test-engines.js [builtin|vercel|both]
 */
const http = require('http');
const WS = require('ws');
const { execSync } = require('child_process');
const fs = require('fs');

const TESTS = [
  // Basic tools
  { name: 'read_file', msg: '读取package.json的name字段值，只回答值', check: t => t.includes('dsme') },
  { name: 'run_command', msg: '运行 echo ENGINE_OK_2026 并告诉我输出', check: t => t.includes('ENGINE_OK_2026') },
  { name: 'list_directory', msg: '列出 src/components 目录的文件清单', check: t => t.includes('ChatPanel') || t.includes('.tsx') },
  { name: 'search_codebase', msg: '搜索代码中VercelAgent出现在哪些文件', check: t => t.includes('vercel') || t.includes('VercelAgent') },
  { name: 'simple_chat', msg: '计算 123+456 的结果，只回答数字', check: t => t.includes('579') },

  // Advanced scenarios
  { name: 'multi_tool_chain',
    msg: '先读取package.json看version，再运行 node -e "console.log(process.version)" 看node版本，最后把两个版本号都告诉我',
    check: t => (t.includes('1.0.0') || t.includes('version')) && (t.includes('v') || t.includes('node')) },

  { name: 'write_file',
    msg: '创建文件 /tmp/dsme-test-output.txt 内容为 DSME_WRITE_TEST_OK',
    check: t => {
      // Check both response and actual file
      try { const f = fs.readFileSync('/tmp/dsme-test-output.txt', 'utf8'); return f.includes('DSME_WRITE_TEST_OK'); } catch { return false; }
    }},

  { name: 'error_handling',
    msg: '读取一个不存在的文件 /tmp/this_file_does_not_exist_xyz.txt',
    check: t => t.includes('不存在') || t.includes('没有') || t.includes('error') || t.includes('Error') || t.includes('找不到') || t.includes('No such') || t.includes('ENOENT') },

  { name: 'context_retain',
    msg: '我之前让你运行的echo命令输出了什么内容？',
    check: t => t.includes('ENGINE_OK_2026') || t.includes('echo') },

  { name: 'complex_command',
    msg: '运行 find /Users/student2028/code/dsme/src/components -name "*.tsx" | wc -l 告诉我有几个tsx文件',
    check: t => /\d+/.test(t) },
];

function getWSUrl() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:19222/json', res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        const p = JSON.parse(d).find(x => x.url.includes('5173'));
        resolve(p?.webSocketDebuggerUrl);
      });
    }).on('error', reject);
  });
}

function makeEval(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl);
    ws.on('open', () => {
      let id = 1;
      const ev = (expr) => new Promise(r => {
        const i = id++;
        ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
        const h = raw => { const m = JSON.parse(raw.toString()); if (m.id === i) { ws.removeListener('message', h); r(m.result?.result?.value); } };
        ws.on('message', h);
      });
      resolve({ ev, ws });
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 8000);
  });
}

const GET_LAST_MD = `(() => {
  const mds = document.querySelectorAll('.md-content');
  if (!mds.length) return '';
  return mds[mds.length - 1].innerText || '';
})()`;

async function runTest(ev, test, timeout = 55) {
  const start = Date.now();
  const beforeCount = await ev(`document.querySelectorAll('.md-content').length`) || 0;
  const beforeText = await ev(GET_LAST_MD) || '';

  await ev(`window.electronAPI.sendChatMessage(\`${test.msg.replace(/`/g, '\\`')}\`)`);
  await new Promise(r => setTimeout(r, 3000));

  let lastText = '', stableCount = 0;
  for (let i = 0; i < timeout; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const curCount = await ev(`document.querySelectorAll('.md-content').length`) || 0;
    const text = await ev(GET_LAST_MD) || '';

    // New message appeared (count increased) or existing message grew
    const hasNew = curCount > beforeCount || (text !== beforeText && text.length > beforeText.length + 5);
    if (!hasNew) continue;

    // Skip pure tool-name markers
    const newPart = text.slice(beforeText.length).trim();
    const toolNames = ['read_file','write_file','replace_in_file','list_directory','search_codebase','run_command','web_search','fetch_url'];
    if (newPart.length < 10 || toolNames.some(t => newPart.replace(/[>\s*`|]/g,'') === t)) { stableCount = 0; lastText = text; continue; }

    if (text === lastText) {
      stableCount++;
      if (stableCount >= 3) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const checkText = curCount > beforeCount ? text : newPart;
        return { pass: test.check(checkText), elapsed, snippet: checkText.replace(/\n/g, ' ').slice(0, 100).trim() };
      }
    } else { stableCount = 0; lastText = text; }
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const finalText = lastText || await ev(GET_LAST_MD) || '';
  const newPart = finalText.slice(beforeText.length).trim();
  const checkText = newPart.length > 5 ? newPart : finalText;
  return { pass: test.check(checkText), elapsed, snippet: (checkText || 'NO_RESPONSE').replace(/\n/g, ' ').slice(0, 100).trim() };
}

async function testEngine(engineName) {
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  🧪 Testing: ${engineName.toUpperCase()} ENGINE (${TESTS.length} scenarios)`);
  console.log(`${'═'.repeat(62)}`);

  // Clean up test artifacts
  try { fs.unlinkSync('/tmp/dsme-test-output.txt'); } catch {}

  const wsUrl = await getWSUrl();
  if (!wsUrl) { console.log('  ❌ No browser page found'); return null; }
  const { ev, ws } = await makeEval(wsUrl);

  const results = [];
  for (const test of TESTS) {
    process.stdout.write(`  ${(test.name + ' ').padEnd(20, '·')} `);
    const r = await runTest(ev, test);
    results.push({ name: test.name, ...r });
    const icon = r.pass ? '✅' : '❌';
    console.log(`${icon} ${r.elapsed.padStart(5)}s  ${r.snippet.slice(0, 50)}`);
    await new Promise(r => setTimeout(r, 2500));
  }

  ws.close();
  return { engine: engineName, results };
}

function switchAndRestart(name) {
  try {
    execSync(`cd /Users/student2028/code/dsme && node -e "
      const http=require('http'),WS=require('ws');
      http.get('http://127.0.0.1:19222/json',res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{
        const p=JSON.parse(d).find(x=>x.url.includes('5173'));
        if(!p){process.exit(0);}
        const ws=new WS(p.webSocketDebuggerUrl);
        ws.on('open',async ()=>{
          let id=1;
          function ev(e){return new Promise(r=>{const i=id++;ws.send(JSON.stringify({id:i,method:'Runtime.evaluate',params:{expression:e,returnByValue:true,awaitPromise:true}}));const h=raw=>{const m=JSON.parse(raw.toString());if(m.id===i){ws.removeListener('message',h);r(m.result?.result?.value);}};ws.on('message',h);});}
          const cfg=await ev('window.electronAPI.getConfig().then(c=>JSON.stringify(c))');
          const config=JSON.parse(cfg);
          config.agentKernel='${name}';
          await ev(\\\`window.electronAPI.saveConfig(\\\${JSON.stringify(config)}).then(()=>'ok')\\\`);
          ws.close();process.exit(0);
        });
        ws.on('error',()=>process.exit(0));
      });
    }).on('error',()=>process.exit(0));
    "`, { encoding: 'utf8', timeout: 10000 });
  } catch {}
  execSync('sleep 1');
  try { execSync('pkill -f "Electron" 2>/dev/null', { timeout: 3000 }); } catch {}
  try { execSync('pkill -f "node.*vite" 2>/dev/null', { timeout: 3000 }); } catch {}
  execSync('sleep 3');

  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn('npm', ['run', 'dev'], { cwd: '/Users/student2028/code/dsme', detached: true, stdio: 'pipe' });
    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });
    const check = setInterval(() => {
      if (output.includes('[CDP]')) {
        clearInterval(check);
        proc.unref();
        const m = output.match(/Using (.*?) kernel/);
        console.log(`  ✓ App ready (${m ? m[1] : '?'} kernel)`);
        setTimeout(() => resolve(), 3000);
      }
    }, 500);
    setTimeout(() => { clearInterval(check); reject(new Error('timeout')); }, 30000);
  });
}

async function main() {
  const mode = process.argv[2] || 'both';
  const allResults = [];

  if (mode === 'builtin' || mode === 'both') {
    console.log('\n🔄 Starting built-in engine...');
    await switchAndRestart('builtin');
    const r = await testEngine('builtin');
    if (r) allResults.push(r);
  }
  if (mode === 'vercel' || mode === 'both') {
    console.log('\n🔄 Starting Vercel engine...');
    await switchAndRestart('vercel');
    const r = await testEngine('vercel');
    if (r) allResults.push(r);
  }

  // Summary
  console.log(`\n${'═'.repeat(62)}`);
  console.log('  📊 FINAL COMPARISON');
  console.log(`${'═'.repeat(62)}\n`);

  const cw = 16;
  let hdr = '  Scenario'.padEnd(22);
  for (const r of allResults) hdr += r.engine.padEnd(cw);
  console.log(hdr);
  console.log('  ' + '─'.repeat(22 + cw * allResults.length));

  for (const test of TESTS) {
    let line = `  ${test.name.padEnd(20)}`;
    for (const eng of allResults) {
      const r = eng.results.find(x => x.name === test.name);
      line += `${r.pass ? '✅' : '❌'} ${r.elapsed.padStart(5)}s`.padEnd(cw);
    }
    console.log(line);
  }

  console.log('  ' + '─'.repeat(22 + cw * allResults.length));
  let tot = '  TOTAL'.padEnd(22);
  for (const eng of allResults) {
    const n = eng.results.filter(r => r.pass).length;
    tot += `${n}/${TESTS.length} ${n === TESTS.length ? '🎉' : n >= TESTS.length - 1 ? '👍' : '⚠️'}`.padEnd(cw);
  }
  console.log(tot);
  console.log('');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
