import type {
  SettingsView as SettingsViewData,
  SystemView,
  UpdateSettingsRequest,
} from '@notification-hub/shared';
import { ApiSettings } from './ApiSettings';
import { SystemSettings } from './SystemSettings';
import { ThemeSettings } from './ThemeSettings';

interface SettingsViewProps {
  settings: SettingsViewData | null;
  loading: boolean;
  saving: boolean;
  onSave: (patch: UpdateSettingsRequest) => Promise<boolean>;
  onClear: () => Promise<void>;
  system: SystemView | null;
  systemLoading: boolean;
  systemBusy: boolean;
  systemError: string | null;
  systemFinishing: 'shutdown' | 'uninstall' | null;
  onToggleAutostart: () => void;
  onShutdown: () => void;
  onUninstall: () => void;
}

/**
 * 设置页：API 调用 + 外观风格 + 系统（关闭 / 卸载 / 开机自启）。
 *
 * 「开机自启」原本是"看得见但点不动"的占位，现在已经是真的开关；
 * 「关闭」「卸载」也收口在这里，用户不必再去项目目录里找停止脚本。
 */
export function SettingsView({
  settings,
  loading,
  saving,
  onSave,
  onClear,
  system,
  systemLoading,
  systemBusy,
  systemError,
  systemFinishing,
  onToggleAutostart,
  onShutdown,
  onUninstall,
}: SettingsViewProps) {
  return (
    <div className="settings-page">
      <section className="settings-section" aria-label="API 调用">
        <h3 className="settings-section__title">API 调用</h3>
        <p className="settings-section__desc">
          填入 DeepSeek API Key 后，摘要由真实模型生成；不填则用内置的本地启发式摘要器。
        </p>
        <ApiSettings
          settings={settings}
          loading={loading}
          saving={saving}
          onSave={onSave}
          onClear={onClear}
        />
      </section>

      <ThemeSettings />

      <SystemSettings
        system={system}
        loading={systemLoading}
        busy={systemBusy}
        error={systemError}
        finishing={systemFinishing}
        onToggleAutostart={onToggleAutostart}
        onShutdown={onShutdown}
        onUninstall={onUninstall}
      />
    </div>
  );
}
