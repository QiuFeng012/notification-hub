import type { ReactNode } from 'react';
import type { SettingsView as SettingsViewData, UpdateSettingsRequest } from '@notification-hub/shared';
import { ApiSettings } from './ApiSettings';

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

/** 设置页：API 调用 + 两个已经占位、还没实现的分组 */
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

      <PlannedSetting
        title="外观风格"
        desc="切换界面配色与字体。目前只有「米白」这一套。"
        control={
          <div className="planned-options">
            <span className="planned-option planned-option--current">米白（当前）</span>
            <span className="planned-option">深色</span>
            <span className="planned-option">跟随系统</span>
          </div>
        }
        reason="没做的原因：配色统一由 styles.css 顶部的 CSS 变量决定，切换主题要先把这些变量收敛成可切换的方案，否则会改成一半、半页不对。"
      />

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
