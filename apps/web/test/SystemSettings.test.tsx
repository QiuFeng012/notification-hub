import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SystemView } from '@notification-hub/shared';
import { SystemSettings } from '../src/components/SystemSettings';

function baseProps(overrides: Partial<React.ComponentProps<typeof SystemSettings>> = {}) {
  const system: SystemView = { autostart: false, port: 5178, dataDir: '/data' };
  return {
    system,
    loading: false,
    busy: false,
    error: null as string | null,
    finishing: null as 'shutdown' | 'uninstall' | null,
    onToggleAutostart: vi.fn(),
    onShutdown: vi.fn(),
    onUninstall: vi.fn(),
    ...overrides,
  };
}

describe('SystemSettings', () => {
  it('显示开机自启、静默说明与端口/数据目录', () => {
    render(<SystemSettings {...baseProps()} />);
    expect(screen.getByRole('heading', { name: '系统' })).toBeInTheDocument();
    expect(screen.getByText('开机自启')).toBeInTheDocument();
    expect(screen.getByText(/静默/)).toBeInTheDocument();
    expect(screen.getByText('5178')).toBeInTheDocument();
    expect(screen.getByText('/data')).toBeInTheDocument();
  });

  it('自启开关反映当前状态，点击触发切换', async () => {
    const onToggleAutostart = vi.fn();
    render(
      <SystemSettings
        {...baseProps({
          system: { autostart: true, port: 5178, dataDir: '/data' },
          onToggleAutostart,
        })}
      />,
    );

    const toggle = screen.getByRole('switch', { name: '开机自启' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(toggle);
    expect(onToggleAutostart).toHaveBeenCalledTimes(1);
  });

  it('点「退出应用」触发 onShutdown', async () => {
    const onShutdown = vi.fn();
    render(<SystemSettings {...baseProps({ onShutdown })} />);
    await userEvent.click(screen.getByRole('button', { name: '退出应用' }));
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('卸载需要两段确认，第二段含"无法恢复"，两段都确认才触发', async () => {
    const onUninstall = vi.fn();
    render(<SystemSettings {...baseProps({ onUninstall })} />);

    // 第一段：点开确认
    await userEvent.click(screen.getByRole('button', { name: '卸载应用' }));
    expect(screen.getByRole('button', { name: '继续卸载' })).toBeInTheDocument();
    expect(onUninstall).not.toHaveBeenCalled();

    // 第二段：明确警告
    await userEvent.click(screen.getByRole('button', { name: '继续卸载' }));
    expect(screen.getByText(/无法恢复/)).toBeInTheDocument();
    expect(onUninstall).not.toHaveBeenCalled();

    // 最终确认
    await userEvent.click(screen.getByRole('button', { name: '确认卸载' }));
    expect(onUninstall).toHaveBeenCalledTimes(1);
  });

  it('取消确认后不触发卸载', async () => {
    const onUninstall = vi.fn();
    render(<SystemSettings {...baseProps({ onUninstall })} />);

    await userEvent.click(screen.getByRole('button', { name: '卸载应用' }));
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onUninstall).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '卸载应用' })).toBeInTheDocument();
  });
});
