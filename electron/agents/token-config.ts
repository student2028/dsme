export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
export const DEFAULT_MAX_CONTEXT_TOKENS = 128_000;
export const DEFAULT_MAX_TOOL_STEPS = 200;

export interface TokenLimits {
  maxOutputTokens: number;
  maxContextTokens: number;
}

export function parseTokenLimit(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return fallback;

  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function getTokenLimitsFromEnv(
  env: Record<string, string | undefined>,
  fallback: TokenLimits = {
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  },
): TokenLimits {
  return {
    maxOutputTokens: parseTokenLimit(env.MAX_OUTPUT_TOKENS, fallback.maxOutputTokens),
    maxContextTokens: parseTokenLimit(env.MAX_CONTEXT_TOKENS, fallback.maxContextTokens),
  };
}

export function estimateTokenCount(value: unknown): number {
  if (value == null) return 0;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil((text || '').length / 4);
}

export function estimateMessagesTokens(messages: Array<{ content?: unknown }>): number {
  return messages.reduce((sum, msg) => sum + estimateTokenCount(msg.content), 0);
}

export function deriveHistoryBudgetTokens(maxContextTokens: number): number {
  return Math.max(1_000, Math.floor(maxContextTokens * 0.75));
}

export function deriveNonUserContentCapChars(maxContextTokens: number): number {
  return Math.max(3_000, Math.floor(maxContextTokens * 0.4));
}

export function deriveToolResultCapChars(maxContextTokens: number): number {
  return Math.max(16_000, Math.min(200_000, Math.floor(maxContextTokens)));
}
