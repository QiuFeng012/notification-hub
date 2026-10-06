import type { ReactNode } from 'react';
import type { SettingsView as SettingsViewData, UpdateSettingsRequest } from '@notification-hub/shared';
import { ApiSettings } from './ApiSettings';
import { ThemeSettings } from './ThemeSettings';

interface SettingsViewProps {
  settings: SettingsViewData | null;
  loading: boolean;
  saving: boolean;
  onSave: (patch: UpdateSettingsRequest) => Promise<boolean>;
  onClear: () => Promise<void>;
}

/**
 * 还没实现的设置项。
 *
 * 刻意做成"看得见但点不动"，而不是干脆不画：先把位置和形状占住，
 * 每次进设置都能看到还差什么。但必须**明确写着没做**——
 * 一个能点、点了没反应的开关比没有这个开关更糟。
 *
 * 「外观风格」原本也走这里，现在已经真的实现了，于是换成 ThemeSettings。
 */
function PlannedSetting({
  title,
  desc,
  control,
  reason,
}: {
  title: string;
  desc: string;
  control: ReactNode;
  reason: string;
}) {
  return (
    <section className="settings-section settings-section--planned" aria-label={`${title}（待实现）`}>
      <div className="settings-section__head">
        <h3 className="settings-section__title">{title}</h3>
        <span className="badge-planned" data-testid="planned-badge">
          待实现
        </span>
      </div>
      <p className="settings-section__desc">{desc}</p>
      <div className="settings-section__control" aria-disabled="true">
        {control}
      </div>
      <p className="settings__hint">{reason}</p>
    </section>
  );
}

/** 设置页：API 调用 + 已实现的外观风格 + 仍然占位的开机自启 */
export function SettingsView({ settings, loading, saving, onSave, onClear }: SettingsViewProps) {
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

      <PlannedSetting
        title="开机自启"
        desc="开机后自动启动本机服务，省掉双击启动脚本这一步。"
        control={
          <span className="planned-switch" aria-hidden="true">
            <span className="planned-switch__knob" />
          </span>
        }
        reason="没做的原因：它要往系统里写启动项（启动文件夹或注册表），属于会改动系统状态的设置。做的时候需要配套的关闭与卸载路径，不该顺手加上。"
      />
    </div>
  );
}
