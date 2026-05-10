/**
 * DSME Markdown Renderer — Syntax-highlighted markdown rendering
 *
 * Extracted from ChatPanel.tsx to reduce component bloat.
 * Handles hljs language registration, marked configuration,
 * and provides a memoized component for streaming performance.
 */

import React, { useMemo } from 'react';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import xml from 'highlight.js/lib/languages/xml';
import kotlin from 'highlight.js/lib/languages/kotlin';
import dart from 'highlight.js/lib/languages/dart';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import swift from 'highlight.js/lib/languages/swift';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import sql from 'highlight.js/lib/languages/sql';
import diff from 'highlight.js/lib/languages/diff';

// ── Register languages ──
const LANG_MAP: [string, any][] = [
  ['typescript', typescript], ['ts', typescript], ['tsx', typescript],
  ['javascript', javascript], ['js', javascript], ['jsx', javascript],
  ['python', python], ['py', python],
  ['css', css], ['json', json],
  ['bash', bash], ['sh', bash], ['shell', bash],
  ['html', xml], ['xml', xml],
  ['kotlin', kotlin], ['kt', kotlin],
  ['dart', dart], ['go', go],
  ['rust', rust], ['rs', rust],
  ['java', java], ['swift', swift],
  ['markdown', markdown], ['md', markdown],
  ['yaml', yaml], ['yml', yaml],
  ['sql', sql], ['diff', diff],
];

for (const [name, lang] of LANG_MAP) {
  hljs.registerLanguage(name, lang);
}

// ── Configure marked ──
marked.setOptions({ breaks: true, gfm: true });

const renderer = new marked.Renderer();
renderer.code = function({ text, lang }: { text: string; lang?: string }) {
  let highlighted = text;
  const language = lang || '';
  try {
    if (language && hljs.getLanguage(language)) {
      highlighted = hljs.highlight(text, { language }).value;
    } else {
      highlighted = hljs.highlightAuto(text).value;
    }
  } catch {}
  const lines = highlighted.split('\n');
  const numberedLines = lines.map((line, i) =>
    `<span class="code-line"><span class="line-num">${i + 1}</span>${line}</span>`
  ).join('\n');
  const b64 = btoa(unescape(encodeURIComponent(text)));
  const lineCount = lines.length;
  return `<div class="md-code-block"><div class="md-code-header"><span class="md-code-lang">${language || 'code'}</span><span class="md-code-lines">${lineCount} lines</span><button class="md-code-copy" data-code="${b64}" onclick="try{var t=decodeURIComponent(escape(atob(this.getAttribute('data-code'))));navigator.clipboard.writeText(t);this.textContent='✓ Copied';this.classList.add('copied');setTimeout(()=>{this.textContent='Copy';this.classList.remove('copied')},2000)}catch(e){this.textContent='✗ Failed'}">Copy</button></div><pre><code class="hljs has-line-numbers">${numberedLines}</code></pre></div>`;
};
marked.use({ renderer });

function renderMarkdown(content: string): string {
  try { return marked.parse(content) as string; }
  catch { return content; }
}

// ── Memoized component ──
export const MemoizedMarkdown = React.memo(
  ({ content, isStreaming }: { content: string; isStreaming: boolean }) => {
    const html = useMemo(() => renderMarkdown(content), [content]);
    return <div className={`md-content${isStreaming ? ' streaming' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
  },
  (prev, next) => prev.content === next.content && prev.isStreaming === next.isStreaming
);
