import type { SettingsView, UpdateSettingsResponse } from '@notification-hub/shared';
import { validateApiKey } from '../ai/validate-api-key.js';
import { InvalidApiKeyError } from '../ai/types.js';
import type { SettingsStore } from '../settings/settings-store.js';

/** 设置相关的业务错误，由 HTTP 层映射成 400 */
export class SettingsValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SettingsValidationError';
    this.code = code;
  }
}

export interface SettingsServiceOptions {
  store: SettingsStore;
  defaultBaseUrl: string;
  defaultModel: string;
  /** 验证 Key 的超时时间：面向交互，不能像摘要那样等 45 秒 */
  validationTimeoutMs?: number;
  /** 可注入，便于测试 */
  fetchImpl?: typeof fetch;
}

const DEFAULT_VALIDATION_TIMEOUT_MS = 15_000;

export interface SettingsService {
  get(): SettingsView;
  update(patch: { apiKey?: string; baseUrl?: string; model?: string }): Promise<UpdateSettingsResponse>;
  clear(): SettingsView;
}

export function createSettingsService(options: SettingsServiceOptions): SettingsService {
  const { store, defaultBaseUrl, defaultModel } = options;
  const validationTimeoutMs = options.validationTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;

  return {
    get() {
      return store.view();
    },

    async update(patch) {
      // 先算出"保存后会生效的设置"。验证要针对生效值，
      // 否则"只改 baseUrl 不动 Key"这种情况会绕过验证，
      // 把一个连不上的地址存下来，用户下次用才发现。
      const current = store.resolve();
      const effectiveKey = patch.apiKey !== undefined ? patch.apiKey.trim() : current.apiKey;
      const effectiveBaseUrl = patch.baseUrl?.trim() || current.baseUrl || defaultBaseUrl;
      const effectiveModel = patch.model?.trim() || current.model || defaultModel;

      let warning: string | null = null;

      if (effectiveKey) {
        try {
          await validateApiKey({
            apiKey: effectiveKey,
            baseUrl: effectiveBaseUrl,
            model: effectiveModel,
            timeoutMs: validationTimeoutMs,
            ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
          });
        } catch (error) {
          if (error instanceof InvalidApiKeyError) {
            // 密钥确定无效：拒绝保存，避免把确定错误的东西写进去
            throw new SettingsValidationError('INVALID_API_KEY', error.message);
          }
          // 网络不通、限流等无法判定的情况：仍然保存，但明确告知用户没验成
          const reason = error instanceof Error ? error.message : String(error);
          warning = `设置已保存，但没能验证通过：${reason}`;
        }
      }

      // 验证通过后才落盘，避免"验证失败但已经写了一半"
      let settings: SettingsView;
      try {
        settings = store.save(patch);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new SettingsValidationError('VALUE_TOO_LONG', reason);
      }

      return { settings, warning };
    },

    clear() {
      return store.clear();
    },
  };
}
