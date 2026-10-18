import { useState } from 'react';
import type { SystemView } from '@notification-hub/shared';

interface SystemSettingsProps {
  system: SystemView | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  finishing: 'shutdown' | 'uninstall' | null;
  onToggleAutostart: () => void;
  onShutdown: () => void;
  onUninstall: () => void;
}

/**
 * 设置页「系统」区：开机自启、退出应用、卸载。
 *
 * 卸载是不可逆操作，所以用两段确认：第一段问"确定要卸载吗"，
 * 第二段才亮出"数据将一并删除、无法恢复"的明确警告。
 * 只有第二段确认才真正提交。
 */
export function SystemSettings({
  system,
  loading,
  busy,
  error,
  finishing,
  onToggleAutostart,
  onShutdown,
  onUninstall,
}: SystemSettingsProps) {
  const [confirmStage, setConfirmStage] = useState<0 | 1 | 2>(0);
  const autostart = system?.autostart === true;
  const disabled = loading || busy || !system || finishing !== null;

  return (
    <section className="settings-section" aria-label="系统">
      <h3 className="settings-section__title">系统</h3>

      <div className="system-row">
        <div className="system-row__text">
          <p className="settings__current">开机自启</p>
          <p className="settings-section__desc">
            登录后静默启动本机服务（不弹窗口），让第一次打开更快。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={autostart}
          aria-label="开机自启"
          className={autostart ? 'switch switch--on' : 'switch'}
          disabled={disabled}
          onClick={onToggleAutostart}
        >
          <span className="switch__knob" />
        </button>
      </div>
      <p className="settings__hint">
        登录时在后台预热服务；随时可在设置里关掉，或到系统「启动」文件夹手动删除。
      </p>

      {system ? (
        <p className="settings__current">
          本机服务：端口 <code>{system.port}</code>，数据目录 <code>{system.dataDir}</code>
        </p>
      ) : null}

      {error ? (
        <p className="settings__hint settings__hint--error" role="alert">
          {error}
        </p>
      ) : null}

      {finishing === 'shutdown' ? (
        <p className="settings__hint">已退出，可以关闭这个窗口了。</p>
      ) : null}
      {finishing === 'uninstall' ? (
        <p className="settings__hint settings__hint--error">正在卸载，请稍候…</p>
      ) : null}

      <div className="system-actions">
        <button
          type="button"
          className="button button--ghost"
          onClick={onShutdown}
          disabled={disabled}
        >
          退出应用
        </button>
      </div>

      <div className="system-danger">
        <p className="settings__current">卸载应用</p>
        <p className="settings-section__desc">
          删除本应用的全部数据与应用本身，类似系统里的卸载。
        </p>

        {confirmStage === 0 ? (
          <button
            type="button"
            className="button button--danger"
            onClick={() => setConfirmStage(1)}
            disabled={disabled}
          >
            卸载应用
          </button>
        ) : null}

        {confirmStage === 1 ? (
          <div role="group" aria-label="确认卸载第一步">
            <p className="settings__hint">确定要卸载本应用吗？这会停止服务并删除应用。</p>
            <div className="system-actions">
              <button
                type="button"
                className="button button--danger"
                onClick={() => setConfirmStage(2)}
                disabled={disabled}
              >
                继续卸载
              </button>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setConfirmStage(0)}
                disabled={busy}
              >
                取消
              </button>
            </div>
          </div>
        ) : null}

        {confirmStage === 2 ? (
          <div role="group" aria-label="确认卸载第二步">
            <p className="settings__hint settings__hint--error">
              卸载将删除本应用全部数据，包括所有信息卡和 API 设置，且无法恢复。
            </p>
            <div className="system-actions">
              <button
                type="button"
                className="button button--danger"
                onClick={onUninstall}
                disabled={disabled}
              >
                确认卸载
              </button>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setConfirmStage(0)}
                disabled={busy}
              >
                取消
              </button>
            </div>
            <p className="settings__hint">
              浏览器自行安装的应用图标需到 edge://apps 或 chrome://apps 里手动移除。
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
