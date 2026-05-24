/**
 * DSME Unit Tests — RAG Engine + Shared Tools
 *
 * Runs without Electron, pure Node.js.
 * Tests core algorithms: tokenizer, TF-IDF, cosine similarity,
 * incremental indexing, and shared-tools safety checks.
 */

import {
  countSearchResultLines,
  formatWebSearchResult,
  hasUsableSearchResults,
} from '../electron/agents/search-result-format.ts';
import { isCommandBlocked } from '../electron/lib/command-guard.ts';
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
  looksLikeIncompleteModelText,
  shouldContinueModelText,
} from '../electron/agents/continuation.ts';
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  deriveNonUserContentCapChars,
  deriveToolResultCapChars,
  getTokenLimitsFromEnv,
  parseTokenLimit,
} from '../electron/agents/token-config.ts';
import { formatAxSnapshot } from '../electron/browser/ax-snapshot-format.ts';
import { parseTextToolCalls } from '../electron/agents/text-tool-parser.ts';
let passed = 0, failed = 0;

function assert(condition, label) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}`); failed++; }
}



// ──────────────────────────────────────────────────────────────────
console.log('\n🧪 DSME Unit Tests\n');

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
  assert(toolResult.includes('```tool-output'), 'Tool result uses collapsible tool-output fence');
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

// ── Test 10: Mid-sentence continuation detection ──
console.log('\n✂️ Mid-sentence Continuation Detection');
{
  const incomplete = '提示：出行需做好防晒防暑，农业区域注意防范干热风对';
  assert(looksLikeIncompleteModelText(incomplete), 'Chinese answer ending mid-clause is incomplete');
  assert(!looksLikeIncompleteModelText(`${incomplete}小麦生长的不利影响。`), 'Chinese answer ending with punctuation is complete');
  assert(shouldContinueModelText({
    finishReason: 'tool-calls',
    modelText: incomplete,
    lastStepWasText: true,
    lastMessageHasToolCall: false,
  }), 'Mid-sentence text continues even when provider finish reason is not stop');
  assert(!shouldContinueModelText({
    finishReason: 'tool-calls',
    modelText: incomplete,
    lastStepWasText: true,
    lastMessageHasToolCall: true,
  }), 'Tool-call argument streams are not treated as final-answer truncation');
}

// ── Test 11: Command guard ──
console.log('\n🛡️ Command Guard');
{
  assert(isCommandBlocked('rm -rf /'), 'Destructive rm -rf / is blocked');
  assert(!isCommandBlocked('npm run test:unit'), 'Benign npm script is allowed');
}

// ── Test 12: Accessibility snapshot formatting ──
console.log('\n🌳 Accessibility Snapshot Format');
{
  const interactiveRoles = new Set(['button', 'link', 'textbox']);
  const result = formatAxSnapshot({
    title: 'Example',
    url: 'https://example.com',
    nodes: [
      { ignored: true, role: { value: 'generic' } },
      { role: { value: 'button' }, name: { value: 'Submit' }, backendDOMNodeId: 42 },
      { role: { value: 'heading' }, name: { value: 'Welcome' } },
    ],
    interactiveRoles,
  });
  assert(result.text.includes('Page: Example'), 'Snapshot includes page title');
  assert(result.text.includes('[e1] button "Submit"'), 'Interactive node gets ref label');
  assert(result.refMap.get('e1')?.backendNodeId === 42, 'Ref map stores backend node id');
  assert(result.diagnostics.refCount === 1, 'Diagnostics count interactive refs');
}

// ── Test 13: Text tool call parser ──
console.log('\n🔧 Text Tool Call Parser');
{
  const tools = ['web_search', 'run_command', 'write_file'];
  const xml = 'Before <function=web_search>{"query":"weather"}</function> after';
  const xmlCalls = parseTextToolCalls(xml, tools);
  assert(xmlCalls.length === 1 && xmlCalls[0].name === 'web_search', 'XML function block is parsed');

  const hermes = '[TOOL_CALLS] [{"name":"run_command","arguments":{"command":"echo hi"}}]';
  const hermesCalls = parseTextToolCalls(hermes, tools);
  assert(hermesCalls[0]?.args.command === 'echo hi', 'Hermes JSON tool calls are parsed');

  const jsonBlock = 'Use this:\n```json\n{"query":"dsme github"}\n```';
  const jsonCalls = parseTextToolCalls(jsonBlock, tools);
  assert(jsonCalls[0]?.name === 'web_search', 'JSON code block infers web_search from query key');
}

console.log(`\n╔══════════════════════════════════════╗`);
console.log(`║  UNIT TESTS: ${passed}/${passed + failed}${' '.repeat(22 - String(passed).length - String(passed + failed).length)}║`);
console.log(`╚══════════════════════════════════════╝`);

if (failed > 0) {
  console.log(`\n⚠️ ${failed} FAILED`);
  process.exit(1);
} else {
  console.log('\n🏆 ALL GREEN');
}
