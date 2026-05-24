import { app } from 'electron';
import { join } from 'node:path';
import * as fs from 'node:fs/promises';
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_TOOL_STEPS,
  getTokenLimitsFromEnv,
} from '../agents/token-config';
import { DEFAULT_BUILTIN_USERSCRIPTS } from './builtin-userscripts';
import {
  buildVolcengineProvider,
  DEFAULT_PROVIDERS,
  DEEPSEEK_PROVIDER,
  volcengineModelsNeedRefresh,
  VOLCENGINE_ALWAYS_ENSURE_MODEL_IDS,
  VOLCENGINE_PROVIDER_NAME,
} from './providers';
import type { AppConfig, ProviderConfig, Userscript } from './types';

export function getConfigPath(): string {
  return join(app.getPath('userData'), 'dsme-config.json');
}

function resolveActiveConfig(full: AppConfig): AppConfig {
  const provider = full.providers.find(p => p.name === full.activeProvider) || full.providers[0];
  const tokenLimits = getTokenLimitsFromEnv(process.env, {
    maxOutputTokens: full.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
    maxContextTokens: full.maxContextTokens || DEFAULT_MAX_CONTEXT_TOKENS,
  });
  return {
    ...full,
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    model: full.model || provider.models[0],
    maxToolSteps: full.maxToolSteps || DEFAULT_MAX_TOOL_STEPS,
    ...tokenLimits,
  };
}

async function persistConfig(config: AppConfig): Promise<void> {
  await fs.writeFile(getConfigPath(), JSON.stringify(resolveActiveConfig(config), null, 2), 'utf8');
}

export async function loadConfig(): Promise<AppConfig> {
  const configPath = getConfigPath();
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, 'utf8')) as AppConfig;

    if (!parsed.providers) {
      const mergedSf = DEFAULT_PROVIDERS.map(p =>
        p.name === 'SiliconFlow' ? { ...p, apiKey: parsed.apiKey || p.apiKey } : { ...p },
      );
      const migrated: AppConfig = {
        apiKey: parsed.apiKey || '',
        model: mergedSf[0].models.includes(parsed.model) ? parsed.model : mergedSf[0].models[0],
        baseUrl: parsed.baseUrl || mergedSf[0].baseUrl,
        maxOutputTokens: parsed.maxOutputTokens || DEFAULT_MAX_OUTPUT_TOKENS,
        maxContextTokens: parsed.maxContextTokens || DEFAULT_MAX_CONTEXT_TOKENS,
        providers: mergedSf,
        activeProvider: VOLCENGINE_PROVIDER_NAME,
        bookmarks: [],
        userscripts: [...DEFAULT_BUILTIN_USERSCRIPTS],
      };
      await persistConfig(migrated);
      return resolveActiveConfig(migrated);
    }

    if (!parsed.providers.some((p: ProviderConfig) => p.name === VOLCENGINE_PROVIDER_NAME)) {
      parsed.providers = [buildVolcengineProvider(), ...parsed.providers];
      await persistConfig(parsed);
    }

    if (!parsed.userscripts) {
      parsed.userscripts = [...DEFAULT_BUILTIN_USERSCRIPTS];
      await persistConfig(parsed);
    } else {
      let modified = false;
      for (const builtin of DEFAULT_BUILTIN_USERSCRIPTS) {
        const idx = parsed.userscripts.findIndex((s: Userscript) => s.id === builtin.id);
        if (idx === -1) {
          parsed.userscripts.push(builtin);
          modified = true;
        } else if (parsed.userscripts[idx].code !== builtin.code) {
          parsed.userscripts[idx].code = builtin.code;
          modified = true;
        }
      }
      if (modified) await persistConfig(parsed);
    }

    if (!parsed.providers.some((p: ProviderConfig) => p.name === 'DeepSeek')) {
      parsed.providers.push(DEEPSEEK_PROVIDER);
      await persistConfig(parsed);
    }

    const volcIdx = parsed.providers.findIndex((p: ProviderConfig) => p.name === VOLCENGINE_PROVIDER_NAME);
    if (volcIdx >= 0) {
      let row = parsed.providers[volcIdx];
      let models = [...row.models];
      let dirty = false;

      if (volcengineModelsNeedRefresh(models)) {
        const fresh = buildVolcengineProvider();
        models = [...fresh.models];
        row = { ...row, baseUrl: fresh.baseUrl };
        dirty = true;
      }

      for (const id of VOLCENGINE_ALWAYS_ENSURE_MODEL_IDS) {
        if (!models.includes(id)) {
          models.push(id);
          dirty = true;
        }
      }

      if (dirty) {
        parsed.providers[volcIdx] = { ...row, models };
        if (!models.includes(parsed.model)) {
          parsed.model = models.includes('GLM-5.1') ? 'GLM-5.1' : models[0];
        }
        await persistConfig(parsed);
      }
    }

    return resolveActiveConfig(parsed);
  } catch {
    const volc = buildVolcengineProvider();
    const initialModel =
      process.env.VOLCENGINE_DEFAULT_MODEL?.trim() ||
      (volc.models.includes('GLM-5.1') ? 'GLM-5.1' : volc.models[0]);
    const defaultConfig: AppConfig = {
      apiKey: volc.apiKey,
      model: volc.models.includes(initialModel) ? initialModel : volc.models[0],
      baseUrl: volc.baseUrl,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      maxToolSteps: DEFAULT_MAX_TOOL_STEPS,
      providers: DEFAULT_PROVIDERS,
      activeProvider: VOLCENGINE_PROVIDER_NAME,
      bookmarks: [],
      userscripts: [...DEFAULT_BUILTIN_USERSCRIPTS],
    };
    return resolveActiveConfig(defaultConfig);
  }
}

export async function saveConfig(config: Partial<AppConfig>): Promise<AppConfig> {
  const current = await loadConfig();
  const merged = { ...current, ...config };
  const resolved = resolveActiveConfig(merged);
  await fs.writeFile(getConfigPath(), JSON.stringify(resolved, null, 2), 'utf8');
  return resolved;
}
