import { createDeepSeekSummarizer } from './deepseek-summarizer.js';
import { createMockSummarizer } from './mock-summarizer.js';
import type { Summarizer } from './types.js';

export interface CreateSummarizerOptions {
  apiKey?: string | null;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * 选择摘要器：配置了 Key 就走真实模型，没配置就退回本地启发式摘要。
 *
 * 刻意不因为缺 Key 而报错退出——"打开就能用"比"必须先配 Key"重要得多，
 * 前端会明确标注当前用的是哪一种，不会让人误以为看到的是 AI 结果。
 */
export function createSummarizer(options: CreateSummarizerOptions = {}): Summarizer {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) return createMockSummarizer();

  return createDeepSeekSummarizer({
    apiKey,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
}

export { createDeepSeekSummarizer } from './deepseek-summarizer.js';
export { createMockSummarizer } from './mock-summarizer.js';
export * from './types.js';
