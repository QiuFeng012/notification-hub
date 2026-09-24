import { useCallback, useEffect, useState } from 'react';
import { MAX_API_KEY_LENGTH } from '@notification-hub/shared';
import { ApiError, type SettingsApi } from '../lib/api';
import { toSettingsView } from '../lib/api';
import type { SettingsView } from '@notification-hub/shared';

export interface UseSettingsResult {
  settings: SettingsView | null;
  loading: boolean;
  saving: boolean;
  /** 保存成功后的非致命提示（例如 Key 没能验证通过） */
  notice: string | null;
  error: string | null;
  dismiss: () => void;
  save: (patch: { apiKey?: string; baseUrl?: string; model?: string }) => Promise<boolean>;
  clear: () => Promise<void>;
}

function toMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '发生未知错误';
}

/**
 * API 设置状态：读取、保存（含校验）、清除。
 * 服务端返回的永远是 Key 掩码，完整密钥不经由前端。
 */
export function useSettings(api: SettingsApi): UseSettingsResult {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const view = await api.getSettings();
        if (!cancelled) setSettings(view);
      } catch (caught) {
        if (!cancelled) setError(toMessage(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const dismiss = useCallback(() => {
    setNotice(null);
    setError(null);
  }, []);

  const save = useCallback(
    async (patch: { apiKey?: string; baseUrl?: string; model?: string }) => {
      const key = patch.apiKey?.trim();
      if (key !== undefined && key.length > MAX_API_KEY_LENGTH) {
        setError(`API Key 过长（${key.length} 字符），上限 ${MAX_API_KEY_LENGTH} 字符`);
        return false;
      }

      setSaving(true);
      setError(null);
      setNotice(null);
      try {
        const result = await api.updateSettings(patch);
        setSettings(result.settings);
        setNotice(result.warning ?? '设置已保存');
        return true;
      } catch (caught) {
        setError(toMessage(caught));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [api],
  );

  const clear = useCallback(async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      setSettings(toSettingsView(await api.clearSettings()));
      setNotice('已清除保存的 Key');
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setSaving(false);
    }
  }, [api]);

  return { settings, loading, saving, notice, error, dismiss, save, clear };
}
