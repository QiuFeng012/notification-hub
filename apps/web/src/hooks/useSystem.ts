import { useCallback, useEffect, useState } from 'react';
import type { SystemView } from '@notification-hub/shared';
import { ApiError, type SystemApi } from '../lib/api';

export interface UseSystemResult {
  system: SystemView | null;
  loading: boolean;
  /** 正在切换自启 / 关闭 / 卸载 */
  busy: boolean;
  /** 最近一次操作失败的原因 */
  error: string | null;
  /** 已触发关闭或卸载（界面据此显示收尾提示） */
  finishing: 'shutdown' | 'uninstall' | null;
  dismissError: () => void;
  toggleAutostart: () => Promise<void>;
  shutdown: () => Promise<void>;
  uninstall: () => Promise<void>;
}

function toMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '发生未知错误';
}

/** 关闭自己这个 --app 窗口；浏览器可能拒绝（非脚本打开的窗口），关不掉也不影响服务已退出 */
function closeAppWindow(): void {
  try {
    window.close();
  } catch {
    // 忽略：用户手动关窗口即可
  }
}

/**
 * 设置页「系统」区状态：自启开关、关闭、卸载。
 *
 * 关闭/卸载会让服务端退出，所以成功后只标记 finishing，
 * 不再尝试后续请求——否则界面会对着一个已死的服务反复报错。
 */
export function useSystem(api: SystemApi): UseSystemResult {
  const [system, setSystem] = useState<SystemView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finishing, setFinishing] = useState<'shutdown' | 'uninstall' | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const view = await api.getSystem();
        if (!cancelled) setSystem(view);
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

  const dismissError = useCallback(() => setError(null), []);

  const toggleAutostart = useCallback(async () => {
    if (!system || busy || finishing) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.setAutostart(!system.autostart);
      // 只更新 autostart：接口只回这一个字段，整体替换会把 port/dataDir 抹成默认值
      setSystem((prev) => (prev ? { ...prev, autostart: next.autostart } : prev));
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [api, system, busy, finishing]);

  const shutdown = useCallback(async () => {
    if (busy || finishing) return;
    setBusy(true);
    setError(null);
    try {
      await api.shutdown();
      setFinishing('shutdown');
      closeAppWindow();
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [api, busy, finishing]);

  const uninstall = useCallback(async () => {
    if (busy || finishing) return;
    setBusy(true);
    setError(null);
    try {
      await api.uninstall();
      setFinishing('uninstall');
    } catch (caught) {
      setError(toMessage(caught));
    } finally {
      setBusy(false);
    }
  }, [api, busy, finishing]);

  return { system, loading, busy, error, finishing, dismissError, toggleAutostart, shutdown, uninstall };
}
