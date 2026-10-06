import { useCallback, useEffect, useState } from 'react';
import {
  THEME_DESCRIPTIONS,
  THEME_LABELS,
  THEME_MODES,
  applyTheme,
  readStoredTheme,
  writeStoredTheme,
  type ThemeMode,
} from '../lib/theme';

/**
 * 外观风格：三种主题偏好。
 *
 * 为什么真的存下来而不是只当次生效：这是**长期的显示偏好**，
 * 和"本次关注点"那种一次性的东西不同——每次打开都要重选一遍的开关等于没有。
 *
 * 为什么写成按钮组而不是一个"深色模式"开关：需求里就有三种状态，
 * 用一个开关表达三种状态时，"跟随系统"和"深色"会挤在同一个位置上，
 * 用户点了开关也说不清自己现在选的是哪个。
 */
export function ThemeSettings() {
  // 惰性初始化 + 同步应用：初始值就必须是生效值，
  // 否则会出现"先渲染一帧浅色再变深色"的闪白
  const [mode, setMode] = useState<ThemeMode>(() => {
    applyTheme();
    return readStoredTheme();
  });

  // 系统偏好变了、且当前是「跟随系统」时要跟着切换。
  // 这件事必须在挂载时再确认一次：内联脚本只在页面加载那一刻算过一次。
  useEffect(() => {
    applyTheme();
  }, []);

  const change = useCallback((next: ThemeMode) => {
    writeStoredTheme(next);
    applyTheme();
    setMode(next);
  }, []);

  return (
    <section className="settings-section" aria-label="外观风格">
      <h3 className="settings-section__title">外观风格</h3>
      <p className="settings-section__desc">
        主题只影响界面配色，不影响信息卡里的内容与荧光笔颜色。
      </p>

      <div className="settings-section__control">
        <div className="theme-options" role="radiogroup" aria-label="主题">
          {THEME_MODES.map((option) => {
            const active = option === mode;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={active}
                data-theme-option={option}
                className={active ? 'theme-option theme-option--active' : 'theme-option'}
                onClick={() => change(option)}
              >
                {/* 预览由 CSS 画：色值全部来自主题变量本身，
                    这样以后改配色不会出现"预览和实际不一致" */}
                <span className="theme-option__preview" data-theme-preview={option} aria-hidden="true">
                  <span className="theme-option__bar" />
                  <span className="theme-option__bar theme-option__bar--short" />
                </span>
                <span className="theme-option__label">{THEME_LABELS[option]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <p className="settings__hint">{THEME_DESCRIPTIONS[mode]}</p>
    </section>
  );
}
