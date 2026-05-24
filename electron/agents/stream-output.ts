import type { StreamToolPart } from '../types/common';

const DEFAULT_VISIBLE_TOOL_OUTPUT_CAP = 6000;
const QUICK_VISIBLE_TOOLS = new Set(['web_search', 'fetch_url']);

export function stringifyStreamValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) return value.message || String(value);
  if (Array.isArray(value)) {
    const parts = value.map((p) => {
      if (p == null) return '';
      if (typeof p === 'string') return p;
      if (typeof p === 'object' && 'text' in (p as object))
        return String((p as { text?: unknown }).text ?? '');
      try {
        return JSON.stringify(p);
      } catch {
        return String(p);
      }
    });
    return parts.filter(Boolean).join('\n');
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clipText(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n...(truncated)`;
}

function formatVisibleToolOutput(toolName: string | undefined, value: unknown, cap: number): string {
  const raw = stringifyStreamValue(value).trim();
  const isNullishArg = value === undefined || value === null;
  const body = clipText(
    raw ||
      (isNullishArg
        ? '(工具返回空 — browser_eval 若返回 DOM / PerformanceEntry 等不可序列化对象，Electron 会得到 undefined；请 return JSON.stringify(…) 包裹纯数据。)'
        : '(工具输出为空字符串)'),
    cap,
  );
  const label = toolName ? ` (${toolName})` : '';
  return `\n\n### 工具输出${label}\n\n\`\`\`tool-output\n${body}\n\`\`\`\n`;
}

export function visibleTextFromStreamPart(part: StreamToolPart | null | undefined, cap = DEFAULT_VISIBLE_TOOL_OUTPUT_CAP): string {
  switch (part?.type) {
    case 'tool-result':
      return formatVisibleToolOutput(part.toolName, part.result ?? part.output ?? part.content, cap);
    case 'tool-output-available':
      return formatVisibleToolOutput(part.toolName, part.output ?? part.result ?? part.content, cap);
    case 'tool-output-error': {
      const msg = stringifyStreamValue(part.errorText ?? part.error ?? part).trim();
      return msg ? `\n\n⚠️ **工具错误** — ${clipText(msg, 800)}\n` : '';
    }
    case 'tool-output-denied':
      return '\n\n⚠️ **工具输出被拒绝**\n';
    default:
      return '';
  }
}

export function shouldWatchdogVisibleTool(toolName: string | undefined): boolean {
  return QUICK_VISIBLE_TOOLS.has(String(toolName ?? ''));
}
