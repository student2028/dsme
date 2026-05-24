/** Resilient JSON parse for malformed model tool-call output. */
export function safeJsonParse(raw: string, fallback: unknown = null): unknown {
  if (!raw || typeof raw !== 'string') return fallback;
  let s = raw.trim();

  try {
    return JSON.parse(s);
  } catch {
    void 0;
  }

  const codeBlockMatch = s.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) s = codeBlockMatch[1].trim();

  for (const startChar of ['{', '[']) {
    const idx = s.indexOf(startChar);
    if (idx > 0) {
      s = s.slice(idx);
      break;
    }
  }

  s = s.replace(/,\s*([}\]])/g, '$1');
  s = s.replace(/\bNone\b/g, 'null');
  s = s.replace(/\bTrue\b/g, 'true');
  s = s.replace(/\bFalse\b/g, 'false');
  s = s.replace(/\bNaN\b/g, 'null');
  s = s.replace(/\bInfinity\b/g, 'null');
  s = s.replace(/'/g, '"');

  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}
