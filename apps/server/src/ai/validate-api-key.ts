import { createSummarizer } from './index.js';
import { InvalidApiKeyError, type Summarizer } from './types.js';

export interface ValidateApiKeyOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** 可注入，便于测试 */
  fetchImpl?: typeof fetch;
}

/**
 * 验证用户填写的 API Key 是否真的可用。
 *
 * 发一次极小的真实请求，而不是只校验格式——格式对但密钥无效是最常见的情况，
 * 存下来之后用户第一次用才发现，体验很差。
 *
 * 返回值语义：
 *   - 正常返回 null：验证通过
 *   - 抛 InvalidApiKeyError：密钥确定无效，调用方应拒绝保存
 *   - 抛其他异常：无法判定（网络不通、被限流等），调用方应仍然保存但提示用户
 */
export async function validateApiKey(options: ValidateApiKeyOptions): Promise<null> {
  const summarizer: Summarizer = createSummarizer({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    model: options.model,
    timeoutMs: options.timeoutMs,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });

  if (!summarizer.validate) {
    // 没配 Key 时会拿到 mock 摘要器，它不实现 validate。
    // 走到这里说明调用方逻辑有问题，明确报错而不是静默通过。
    throw new InvalidApiKeyError('未提供可验证的 API Key');
  }

  await summarizer.validate();
  return null;
}
