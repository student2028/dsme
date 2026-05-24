import type { ProviderConfig } from './types';

/** Volcengine Ark Coding API — OpenAI-compatible; configured via VOLCENGINE_* env vars. */
export const VOLCENGINE_PROVIDER_NAME = 'Volcengine';

const VOLCENGINE_MODELS_LEGACY_FALLBACK = [
  'doubao-seed-code',
  'kimi-k2.5',
  'glm-4.7',
  'deepseek-v3.2',
  'minimax-m2.5',
  'Doubao-Seed-2.0-pro',
] as const;

const VOLCENGINE_ALWAYS_ENSURE_MODEL_IDS = [
  'MiniMax-M2.7',
  'Kimi-K2.6',
  'DeepSeek-V4-Flash-Beta',
  'DeepSeek-V4-Pro-Beta',
  'ark-code-latest',
] as const;

const VOLCENGINE_MODELS_FALLBACK = [
  'Doubao-Seed-2.0-Code',
  'Doubao-Seed-2.0-pro',
  'Doubao-Seed-2.0-lite',
  'Doubao-Seed-Code',
  'GLM-5.1',
  'MiniMax-M2.7',
  'Kimi-K2.6',
  'DeepSeek-V4-Flash-Beta',
  'DeepSeek-V4-Pro-Beta',
  'ark-code-latest',
] as const;

function parseCommaSeparatedModels(raw: string | undefined, fallback: readonly string[]): string[] {
  if (!raw?.trim()) return [...fallback];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

export function volcengineModelsNeedRefresh(savedModels: string[]): boolean {
  if (savedModels.length !== VOLCENGINE_MODELS_LEGACY_FALLBACK.length) return false;
  const a = [...savedModels].sort().join('\0');
  const b = [...VOLCENGINE_MODELS_LEGACY_FALLBACK].sort().join('\0');
  return a === b;
}

export function buildVolcengineProvider(): ProviderConfig {
  const models = parseCommaSeparatedModels(process.env.VOLCENGINE_MODELS, VOLCENGINE_MODELS_FALLBACK);
  const envDefault = process.env.VOLCENGINE_DEFAULT_MODEL?.trim();
  const defaultModel = envDefault || 'GLM-5.1';
  const ordered = models.includes(defaultModel) ? models : [defaultModel, ...models];
  return {
    name: VOLCENGINE_PROVIDER_NAME,
    apiKey: process.env.VOLCENGINE_API_KEY || '',
    baseUrl: process.env.VOLCENGINE_API_BASE?.trim() || 'https://ark.cn-beijing.volces.com/api/coding/v3',
    models: ordered,
  };
}

export const SILICONFLOW_PROVIDER: ProviderConfig = {
  name: 'SiliconFlow',
  apiKey: process.env.DSME_API_KEY || '',
  baseUrl: 'https://api.siliconflow.cn/v1',
  models: [
    'deepseek-ai/DeepSeek-V4-Flash',
    'deepseek-ai/DeepSeek-V3.2',
    'Pro/zai-org/GLM-5',
    'Pro/MiniMaxAI/MiniMax-M2.5',
    'Pro/moonshotai/Kimi-K2.5',
    'Qwen/Qwen3-8B',
  ],
};

export const GOOGLE_PROVIDER: ProviderConfig = {
  name: 'Google',
  apiKey: process.env.GOOGLE_API_KEY || '',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  models: ['gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'gemini-2.5-flash'],
};

export const DEEPSEEK_PROVIDER: ProviderConfig = {
  name: 'DeepSeek',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseUrl: 'https://api.deepseek.com',
  models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
};

export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  buildVolcengineProvider(),
  SILICONFLOW_PROVIDER,
  GOOGLE_PROVIDER,
  DEEPSEEK_PROVIDER,
];

export { VOLCENGINE_ALWAYS_ENSURE_MODEL_IDS };
