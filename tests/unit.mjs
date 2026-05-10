/**
 * DSME Unit Tests — RAG Engine + Shared Tools
 *
 * Runs without Electron, pure Node.js.
 * Tests core algorithms: tokenizer, TF-IDF, cosine similarity,
 * incremental indexing, and shared-tools safety checks.
 */

import { RAGEngine } from '../electron/agents/rag.ts';
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
