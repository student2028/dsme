/**
 * DSME Markdown Renderer — Syntax-highlighted markdown rendering
 *
 * Extracted from ChatPanel.tsx to reduce component bloat.
 * Handles hljs language registration, marked configuration,
 * and provides a memoized component for streaming performance.
 *
 * Security: DOMPurify sanitizes all HTML output to prevent XSS.
 * Copy buttons use React event delegation (not inline onclick in innerHTML).
 */

import React, { useMemo, useCallback } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
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

const LANG_MAP: [string, Parameters<typeof hljs.registerLanguage>[1]][] = [
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

marked.setOptions({ breaks: true, gfm: true });

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type CollapsibleCodeKind = 'tool' | 'search';

function getCollapsibleCodeKind(text: string, language: string): CollapsibleCodeKind | null {
  const lang = language.trim();
  if (lang === 'tool-output') return 'tool';
  if (lang === 'search-snippet') return 'search';
  if (lang) return null;
  const t = text.trimStart();
  if (/^(WEB_SEARCH_STATUS|RESULT_COUNT|FETCH_URL_STATUS|QUERY)\s*:/m.test(t)) return 'tool';
  if (/^Results from (Google|Sogou|Baidu|Bing|DuckDuckGo)[:\s]/im.test(text)) return 'search';
  return null;
}

const COLLAPSIBLE_HEADING: Record<CollapsibleCodeKind, string> = {
  tool: '工具输出',
  search: '搜索摘录',
};

const renderer = new marked.Renderer();
renderer.code = function({ text, lang }: { text: string; lang?: string }) {
  const language = (lang || '').trim();
  const collapsibleKind = getCollapsibleCodeKind(text, language);
  const b64 = btoa(unescape(encodeURIComponent(text)));

  let highlighted: string;
  if (collapsibleKind) {
    highlighted = escapeHtml(text);
  } else {
    try {
      if (language && hljs.getLanguage(language)) {
        highlighted = hljs.highlight(text, { language }).value;
      } else {
        highlighted = hljs.highlightAuto(text).value;
      }
    } catch {
      highlighted = escapeHtml(text);
    }
  }

  const lines = highlighted.split('\n');
  const numberedLines = lines.map((line, i) =>
    `<span class="code-line"><span class="line-num">${i + 1}</span>${line}</span>`
  ).join('\n');
  const lineCount = lines.length;

  const copyBtn =
    `<button type="button" class="md-code-copy" data-code="${b64}">Copy</button>`;

  const headerLang = collapsibleKind ? COLLAPSIBLE_HEADING[collapsibleKind] : (language || 'code');
  const headerInner =
    `<span class="md-code-lang">${headerLang}</span><span class="md-code-lines">${lineCount} lines</span>${copyBtn}`;

  if (collapsibleKind) {
    return `<details class="md-code-block md-code-tool-output"><summary class="md-code-header">${headerInner}</summary><pre><code class="hljs has-line-numbers">${numberedLines}</code></pre></details>`;
  }

  return `<div class="md-code-block"><div class="md-code-header">${headerInner}</div><pre><code class="hljs has-line-numbers">${numberedLines}</code></pre></div>`;
};
marked.use({ renderer });

function renderMarkdown(content: string): string {
  try {
    const raw = marked.parse(content) as string;
    return DOMPurify.sanitize(raw, {
      ADD_ATTR: ['data-code'],
      // Code blocks use <details>/<summary> + <button>; DOMPurify 3.x has no getAllTags().
      ADD_TAGS: ['details', 'summary', 'button'],
    });
  } catch { return content; }
}

export const MemoizedMarkdown = React.memo(
  ({ content, isStreaming }: { content: string; isStreaming: boolean }) => {
    const html = useMemo(() => renderMarkdown(content), [content]);

    const handleClick = useCallback((e: React.MouseEvent) => {
      const target = e.target as HTMLElement;
      const btn = target.closest('.md-code-copy') as HTMLElement | null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        const b64 = btn.getAttribute('data-code') || '';
        const text = decodeURIComponent(escape(atob(b64)));
        navigator.clipboard.writeText(text);
        btn.textContent = '✓ Copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2000);
      } catch {
        btn.textContent = '✗ Failed';
      }
    }, []);

    return <div className={`md-content${isStreaming ? ' streaming' : ''}`} dangerouslySetInnerHTML={{ __html: html }} onClick={handleClick} />;
  },
  (prev, next) => prev.content === next.content && prev.isStreaming === next.isStreaming
);
