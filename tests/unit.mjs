/**
 * DSME Unit Tests — RAG Engine + Shared Tools
 *
 * Runs without Electron, pure Node.js.
 * Tests core algorithms: tokenizer, TF-IDF, cosine similarity,
 * incremental indexing, and shared-tools safety checks.
 */

import { RAGEngine } from '../electron/agents/rag.ts';
import {
  countSearchResultLines,
  formatWebSearchResult,
  hasUsableSearchResults,
} from '../electron/agents/shared-tools.ts';
import {
  BROWSER_STEP_RAW_MAX,
  clipRawOutput,
  createBrowserTask,
  finishBrowserStep,
  formatBrowserTaskMarkdown,
  startBrowserStep,
  summarizeOutput,
} from '../src/lib/browserTaskTimeline.ts';
import {
  shouldWatchdogVisibleTool,
  stringifyStreamValue,
  visibleTextFromStreamPart,
} from '../electron/agents/stream-output.ts';
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  deriveNonUserContentCapChars,
  deriveToolResultCapChars,
  getTokenLimitsFromEnv,
  parseTokenLimit,
} from '../electron/agents/token-config.ts';
import { writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const TMP = join(tmpdir(), `dsme-test-${Date.now()}`);
let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}`); failed++; }
}

async function setup() {
  await mkdir(join(TMP, 'src'), { recursive: true });
  await writeFile(join(TMP, 'package.json'), '{"name":"test-project","version":"1.0.0"}');
  await writeFile(join(TMP, 'src/app.ts'), `
import React from 'react';
export function App() {
  const [count, setCount] = React.useState(0);
  return <div onClick={() => setCount(c => c + 1)}>Count: {count}</div>;
}
  `.trim());
  await writeFile(join(TMP, 'src/utils.ts'), `
export function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

export function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}
  `.trim());
  await writeFile(join(TMP, 'src/styles.css'), `
.container { display: flex; gap: 8px; }
.button { padding: 4px 8px; border-radius: 4px; }
  `.trim());
}

async function cleanup() {
  try { await rm(TMP, { recursive: true, force: true }); } catch {}
}

// ──────────────────────────────────────────────────────────────────
console.log('\n🧪 DSME Unit Tests\n');

// ── Test 1: RAG Indexing ──
console.log('📚 RAG Engine — Indexing');
{
  await setup();
  const rag = new RAGEngine();
  const count = await rag.index(TMP);
  assert(count >= 3, `Indexed ${count} files (expected ≥ 3)`);
  assert(rag.isReady, 'Engine marked as ready');
  assert(rag.fileCount === count, `fileCount matches (${rag.fileCount})`);
}

// ── Test 2: RAG Search ──
console.log('\n🔍 RAG Engine — Search');
{
  const rag = new RAGEngine();
  await rag.index(TMP);

  const results = rag.search('fibonacci function');
  assert(results.length > 0, `Found ${results.length} results for "fibonacci"`);
  assert(results[0].path.includes('utils'), `Top result is utils.ts (got: ${results[0].path})`);
  assert(results[0].score > 0, `Score is positive (${results[0].score.toFixed(4)})`);

  const reactResults = rag.search('React useState component');
  assert(reactResults.length > 0, `Found results for "React useState"`);
  assert(reactResults[0].path.includes('app'), `Top result is app.ts (got: ${reactResults[0].path})`);

  const noResults = rag.search('xyznonexistenttoken12345');
  assert(noResults.length === 0, `No results for gibberish query`);
}

// ── Test 3: RAG Context Building ──
console.log('\n📝 RAG Engine — Context Building');
{
  const rag = new RAGEngine();
  await rag.index(TMP);
  const ctx = rag.buildContext('fibonacci');
  assert(ctx.includes('fibonacci'), 'Context contains query term');
  assert(ctx.includes('```'), 'Context includes code fences');
  assert(ctx.includes('relevance'), 'Context shows relevance score');

  const emptyCtx = rag.buildContext('xyznonexistent12345');
  assert(emptyCtx === '', 'Empty context for no-match query');
}

// ── Test 4: RAG Incremental Update ──
console.log('\n🔄 RAG Engine — Incremental Update');
{
  const rag = new RAGEngine();
  await rag.index(TMP);
  const initialCount = rag.fileCount;

  // No changes → no updates
  const noChange = await rag.update();
  assert(noChange.added === 0 && noChange.updated === 0 && noChange.removed === 0,
    'No changes detected when nothing changed');

  // Add a new file
  await writeFile(join(TMP, 'src/newfile.ts'), 'export const NEW = "hello";');
  const afterAdd = await rag.update();
  assert(afterAdd.added === 1, `Detected 1 added file (got ${afterAdd.added})`);
  assert(rag.fileCount === initialCount + 1, `File count increased to ${rag.fileCount}`);

  // Modify existing file
  await new Promise(r => setTimeout(r, 100)); // Ensure mtime changes
  await writeFile(join(TMP, 'src/newfile.ts'), 'export const NEW = "updated value";');
  const afterMod = await rag.update();
  assert(afterMod.updated === 1, `Detected 1 updated file (got ${afterMod.updated})`);

  // Delete file
  await rm(join(TMP, 'src/newfile.ts'));
  const afterDel = await rag.update();
  assert(afterDel.removed === 1, `Detected 1 removed file (got ${afterDel.removed})`);
  assert(rag.fileCount === initialCount, `File count restored to ${rag.fileCount}`);
}

// ── Test 5: Edge Cases ──
console.log('\n⚡ RAG Engine — Edge Cases');
{
  // Empty engine search
  const emptyRag = new RAGEngine();
  const emptyResults = emptyRag.search('anything');
  assert(emptyResults.length === 0, 'Search on unindexed engine returns empty');
  assert(emptyRag.buildContext('test') === '', 'buildContext on unindexed returns empty');

  // Double index
  const rag = new RAGEngine();
  await rag.index(TMP);
  const count1 = rag.fileCount;
  await rag.index(TMP);
  const count2 = rag.fileCount;
  assert(count1 === count2, `Double index yields same count (${count1} = ${count2})`);
}

// ── Test 6: Browser task timeline ──
console.log('\n🌐 Browser Task Timeline');
{
  const task = createBrowserTask('Find account settings', 1000);
  const withStep = startBrowserStep(task, {
    kind: 'navigate',
    label: 'Open settings',
    input: 'https://example.com/settings',
    now: 1100,
  });
  const stepId = withStep.steps[0].id;
  const done = finishBrowserStep(withStep, stepId, {
    status: 'done',
    output: 'Loaded settings page\nURL: https://example.com/settings',
    now: 2350,
  });

  assert(done.steps.length === 1, 'Timeline stores one browser step');
  assert(done.steps[0].status === 'done', 'Finished step is marked done');
  assert(done.steps[0].durationMs === 1250, `Finished step duration is ${done.steps[0].durationMs}ms`);
  assert(done.summary.totalSteps === 1 && done.summary.doneSteps === 1, 'Timeline summary counts completed step');
  assert(done.summary.activeStepId === null, 'Timeline has no active step after completion');
  assert(done.steps[0].outputPreview.includes('Loaded settings page'), 'Timeline stores output preview');
  assert(done.steps[0].outputRaw?.includes('Loaded settings page'), 'Timeline keeps raw output for detail/export');

  const longOut = 'x'.repeat(BROWSER_STEP_RAW_MAX + 500);
  const clipped = clipRawOutput(longOut);
  assert(clipped.length <= BROWSER_STEP_RAW_MAX + 2 && clipped.endsWith('…'), 'Raw output is clipped for storage');

  const md = formatBrowserTaskMarkdown(done, { pageUrl: 'https://example.com/current' });
  assert(md.includes('# Browser session:'), 'Markdown export has heading');
  assert(md.includes('Find account settings'), 'Markdown export includes session title');
  assert(md.includes('https://example.com/current'), 'Markdown export includes page URL');

  const summary = summarizeOutput('a'.repeat(300), 80);
  assert(summary.length <= 81 && summary.endsWith('…'), 'Long browser output is truncated for display');
}

// ── Test 7: Stream tool output visibility ──
console.log('\n🧰 Stream Tool Output Visibility');
{
  const toolResult = visibleTextFromStreamPart({
    type: 'tool-result',
    toolName: 'web_search',
    result: 'Results from Sogou:\n河南禹州明天天气：多云，20-33°C',
  });
  assert(toolResult.includes('工具输出'), 'Tool result is rendered as visible chat text');
  assert(toolResult.includes('河南禹州明天天气'), 'Tool result preserves useful output text');

  const outputAvailable = visibleTextFromStreamPart({
    type: 'tool-output-available',
    toolCallId: 'call-1',
    output: { summary: '页面解析完成', count: 8 },
  });
  assert(outputAvailable.includes('页面解析完成'), 'Tool output available event is rendered visibly');

  const json = stringifyStreamValue({ ok: true, value: 42 });
  assert(json.includes('"ok": true') && json.includes('"value": 42'), 'Non-string stream output is readable JSON');

  assert(shouldWatchdogVisibleTool('web_search'), 'Web search is guarded by the post-tool watchdog');
  assert(!shouldWatchdogVisibleTool('browser_snapshot'), 'Long browser-use tools are not guarded by the quick watchdog');
}

// ── Test 8: Web search result quality metadata ──
console.log('\n🔎 Web Search Result Quality');
{
  const raw = [
    'Results from Sogou:',
    '河南5月13日天气预报：南部多阵雨，北中部高温波动',
    '明日天气预报许昌2026年05月13日天气预报，阴，西南风转西北风',
  ].join('\n');
  const formatted = formatWebSearchResult('河南禹州 明天天气', raw);
  assert(hasUsableSearchResults(raw), 'Search snippets are classified as usable');
  assert(countSearchResultLines(raw) === 2, 'Search result line count ignores headers');
  assert(formatted.includes('WEB_SEARCH_STATUS: ok'), 'Formatted search output has explicit success status');
  assert(formatted.includes('RESULT_COUNT: 2'), 'Formatted search output exposes result count');
  assert(formatted.includes('do not call web_search again'), 'Formatted search output discourages repeat search');

  const empty = formatWebSearchResult('gibberish', 'No results found for "gibberish".');
  assert(empty.includes('WEB_SEARCH_STATUS: empty'), 'Empty search output has explicit empty status');
  assert(empty.includes('RESULT_COUNT: 0'), 'Empty search output does not count the no-results line');

  const weatherCard = 'Results from Google:\n天气卡片：中国河南省洛阳市，温度 29°C，天气 多云，降水概率 10%，湿度 53%，风速 13 公里/时';
  const weatherFormatted = formatWebSearchResult('洛阳明天天气', weatherCard);
  assert(hasUsableSearchResults(weatherCard), 'Google weather card extraction is classified as usable');
  assert(weatherFormatted.includes('WEB_SEARCH_STATUS: ok'), 'Weather card output has explicit success status');
}

// ── Test 9: Model token limit config ──
console.log('\n🧮 Model Token Limit Config');
{
  assert(DEFAULT_MAX_OUTPUT_TOKENS === 16384, 'Default output limit is 16384 tokens');
  assert(DEFAULT_MAX_CONTEXT_TOKENS === 128000, 'Default context budget is 128000 tokens');
  assert(parseTokenLimit('8192', 100) === 8192, 'Positive integer env token limit is accepted');
  assert(parseTokenLimit('0', 100) === 100, 'Zero token limit falls back');
  assert(parseTokenLimit('not-a-number', 100) === 100, 'Invalid token limit falls back');

  const limits = getTokenLimitsFromEnv({
    MAX_OUTPUT_TOKENS: '12000',
    MAX_CONTEXT_TOKENS: '64000',
  });
  assert(limits.maxOutputTokens === 12000, 'MAX_OUTPUT_TOKENS is parsed from env');
  assert(limits.maxContextTokens === 64000, 'MAX_CONTEXT_TOKENS is parsed from env');
  assert(deriveNonUserContentCapChars(128000) > 3000, 'Large context budget raises non-user history cap');
  assert(deriveToolResultCapChars(128000) >= 128000, 'Large context budget raises tool result cap');
}

// Cleanup
await cleanup();

// ── Summary ──
console.log(`\n╔══════════════════════════════════════╗`);
console.log(`║  UNIT TESTS: ${passed}/${passed + failed}${' '.repeat(22 - String(passed).length - String(passed + failed).length)}║`);
console.log(`╚══════════════════════════════════════╝`);

if (failed > 0) {
  console.log(`\n⚠️ ${failed} FAILED`);
  process.exit(1);
} else {
  console.log('\n🏆 ALL GREEN');
}
