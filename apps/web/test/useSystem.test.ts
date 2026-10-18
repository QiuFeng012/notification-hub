import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSystem } from '../src/hooks/useSystem';
import type { SystemApi } from '../src/lib/api';

function fakeApi(overrides: Partial<SystemApi> = {}): SystemApi {
  return {
    getSystem: vi.fn(async () => ({ autostart: false, port: 5178, dataDir: '/data' })),
    setAutostart: vi.fn(async (enabled: boolean) => ({ autostart: enabled })),
    shutdown: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => undefined),
    ...overrides,
  };
}

// api 必须在外层建好再传进去：如果在 renderHook 回调里 new 一个，
// 每次渲染都是新引用，useEffect([api]) 会无限重跑。
describe('useSystem', () => {
  it('挂载后读取 system', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useSystem(api));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.system).toEqual({ autostart: false, port: 5178, dataDir: '/data' });
  });

  it('toggleAutostart 取反并只更新 autostart，不抹掉端口与数据目录', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useSystem(api));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.toggleAutostart();
    });

    expect(api.setAutostart).toHaveBeenCalledWith(true);
    // 接口只回 { autostart }，合并时必须保留 port/dataDir
    expect(result.current.system).toEqual({ autostart: true, port: 5178, dataDir: '/data' });
  });

  it('shutdown 成功后调用 window.close 关掉 --app 窗口', async () => {
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    const api = fakeApi();
    const { result } = renderHook(() => useSystem(api));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.shutdown();
    });

    expect(result.current.finishing).toBe('shutdown');
    expect(closeSpy).toHaveBeenCalledTimes(1);
    closeSpy.mockRestore();
  });

  it('uninstall 成功后标记 finishing', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => useSystem(api));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.uninstall();
    });

    expect(result.current.finishing).toBe('uninstall');
  });

  it('读取失败时记录 error', async () => {
    const api = fakeApi({
      getSystem: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const { result } = renderHook(() => useSystem(api));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('boom');
  });
});
