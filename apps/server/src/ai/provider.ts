import { createSummarizer, type CreateSummarizerOptions } from './index.js';
import type { Summarizer } from './types.js';

/** 当前生效的设置，来自 settings store 的解析结果 */
export interface EffectiveAiSettings {
  apiKey: string | null;
  baseUrl: string | null;
  model: string | null;
}

export interface SummarizerProvider {
  /** 取当前该用的摘要器。设置变化后自动切换，无需重启进程。 */
  get(): Summarizer;
}

/**
 * 按设置动态提供摘要器。
 *
 * 之所以要 Provider 而不是启动时定死一个实例：用户会在界面上填 Key，
 * 填完必须立刻生效，不能要求重启服务。
 * 内部按 (key|baseUrl|model|cacheKey) 缓存，避免每个请求都重建客户端。
 */
export function createSummarizerProvider(
  getSettings: () => EffectiveAiSettings,
  options: CreateSummarizerOptions = {},
): SummarizerProvider {
  let cachedSignature: string | null = null;
  let cached: Summarizer | null = null;

  return {
    get() {
      const settings = getSettings();
      const signature = `${settings.apiKey ?? ''}|${settings.baseUrl ?? ''}|${settings.model ?? ''}`;
      if (cached && signature === cachedSignature) return cached;

      cached = createSummarizer({
        ...options,
        apiKey: settings.apiKey,
        ...(settings.baseUrl !== null ? { baseUrl: settings.baseUrl } : {}),
        ...(settings.model !== null ? { model: settings.model } : {}),
      });
      cachedSignature = signature;
      return cached;
    },
  };
}
