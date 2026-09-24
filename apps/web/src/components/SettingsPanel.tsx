import { useEffect, useRef, useState } from 'react';
import { MAX_API_KEY_LENGTH } from '@notification-hub/shared';
import type { SettingsView } from '@notification-hub/shared';

interface SettingsPanelProps {
  settings: SettingsView | null;
  loading: boolean;
  saving: boolean;
  onSave: (patch: { apiKey?: string; baseUrl?: string; model?: string }) => Promise<boolean>;
  onClear: () => Promise<void>;
}

function describeMode(settings: SettingsView | null): string {
  if (!settings || !settings.configured) return '未配置，正在使用本地启发式摘要';
  if (settings.source === 'user') return '已配置（界面保存）';
  return '已配置（来自环境变量）';
}

/**
 * API 设置面板。
 *
 * 两个刻意的设计：
 *   - 输入框永远为空，只把已保存的 Key 以掩码形式显示在旁边。
 *     完整密钥不回传到前端，避免它出现在页面、浏览器缓存或截图里。
 *   - 留空保存 = 不动已有 Key。只有点「清除」才会删掉。
 */
export function SettingsPanel({ settings, loading, saving, onSave, onClear }: SettingsPanelProps) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const keyInputRef = useRef<HTMLInputElement>(null);

  // 设置变化（例如刚清除）时同步高级项，避免输入框里留着上一次的值
  useEffect(() => {
    setBaseUrl(settings?.baseUrl ?? '');
    setModel(settings?.model ?? '');
  }, [settings?.baseUrl, settings?.model]);

  // 展开时自动聚焦到输入框，少一次点击
  useEffect(() => {
    if (open) keyInputRef.current?.focus();
  }, [open]);

  const trimmedKey = apiKey.trim();
  const keyTooLong = trimmedKey.length > MAX_API_KEY_LENGTH;
  const canSave = !saving && !keyTooLong;

  async function handleSave() {
    if (!canSave) return;
    // apiKey 只在用户真的输入了内容时才提交，留空表示"保持原样"
    const patch: { apiKey?: string; baseUrl?: string; model?: string } = {
      baseUrl: baseUrl.trim(),
      model: model.trim(),
    };
    if (trimmedKey.length > 0) patch.apiKey = trimmedKey;

    const ok = await onSave(patch);
    if (ok) {
      setApiKey('');
      setOpen(false);
    }
  }

  async function handleClear() {
    await onClear();
    setApiKey('');
    setOpen(false);
  }

  const configured = settings?.configured === true;

  return (
    <section className="settings" aria-label="API 设置">
      <button
        type="button"
        className="settings__toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="settings__toggle-label">API 设置</span>
        <span className={configured ? 'settings__state settings__state--on' : 'settings__state settings__state--off'}>
          {loading ? '读取中…' : describeMode(settings)}
        </span>
        <span className="settings__chevron" aria-hidden="true">
          {open ? '收起' : '展开'}
        </span>
      </button>

      {open ? (
        <div className="settings__body">
          <p className="settings__current">
            当前 Key：{settings?.apiKeyMask ? <code>{settings.apiKeyMask}</code> : <span className="settings__none">未配置</span>}
          </p>

          <label className="settings__label" htmlFor="api-key-input">
            DeepSeek API Key
          </label>
          <input
            id="api-key-input"
            ref={keyInputRef}
            className="settings__input"
            type="password"
            value={apiKey}
            placeholder={configured ? '留空则保持当前 Key 不变' : 'sk-...'}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setApiKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void handleSave();
              }
            }}
          />
          {keyTooLong ? (
            <p className="settings__hint settings__hint--error">
              Key 过长（{trimmedKey.length} 字符），上限 {MAX_API_KEY_LENGTH} 字符
            </p>
          ) : null}

          <details className="settings__advanced">
            <summary>高级选项</summary>
            <label className="settings__label" htmlFor="base-url-input">
              接口地址
            </label>
            <input
              id="base-url-input"
              className="settings__input"
              type="text"
              value={baseUrl}
              placeholder="https://api.deepseek.com"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <label className="settings__label" htmlFor="model-input">
              模型名
            </label>
            <input
              id="model-input"
              className="settings__input"
              type="text"
              value={model}
              placeholder="deepseek-chat"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setModel(event.target.value)}
            />
            <p className="settings__hint">填 OpenAI 兼容的地址即可接自建代理；留空则用环境变量里的默认值。</p>
          </details>

          <div className="settings__actions">
            <button type="button" className="button button--primary" onClick={() => void handleSave()} disabled={!canSave}>
              {saving ? '正在验证并保存…' : '保存并验证'}
            </button>
            {configured ? (
              <button type="button" className="button button--danger" onClick={() => void handleClear()} disabled={saving}>
                清除
              </button>
            ) : null}
          </div>

          <p className="settings__hint">
            保存前会真实调用一次模型接口验证 Key；验证不通过不会写入。
            Key 只保存在本机 <code>data/settings.json</code>，不会上传到任何第三方。
          </p>
        </div>
      ) : null}
    </section>
  );
}
