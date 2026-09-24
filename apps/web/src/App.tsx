import { useMemo } from 'react';
import { CardList } from './components/CardList';
import { IngestForm } from './components/IngestForm';
import { SettingsPanel } from './components/SettingsPanel';
import { useCards } from './hooks/useCards';
import { useSettings } from './hooks/useSettings';
import { createCardApi, createSettingsApi } from './lib/api';

/**
 * 应用外壳：左侧输入栏 + API 设置，右侧信息卡时间流。
 * 通过 props 传入 api 是为了在组件测试里注入替身，无需真的发请求。
 */
export interface AppProps {
  api?: ReturnType<typeof createCardApi>;
  settingsApi?: ReturnType<typeof createSettingsApi>;
}

export default function App({ api, settingsApi }: AppProps = {}) {
  const cardApi = useMemo(() => api ?? createCardApi(), [api]);
  const settingsClient = useMemo(() => settingsApi ?? createSettingsApi(), [settingsApi]);

  const { cards, loading, submitting, error, dismissError, submit, remove } = useCards(cardApi);
  const settings = useSettings(settingsClient);

  // 两类提示共用一个位置：错误优先，其次是保存结果
  const message = error ?? settings.error ?? settings.notice;
  const messageTone = error || settings.error ? 'banner--error' : 'banner--ok';
  const dismissMessage = () => {
    if (error) dismissError();
    else settings.dismiss();
  };

  const usingMock = settings.settings !== null && !settings.settings.configured;

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1 className="app__title">信息整合台</h1>
          <p className="app__subtitle">粘贴通知 → AI 提炼要点 → 生成信息卡，数据只存在本机</p>
        </div>
        <span className="app__badge">{loading ? '—' : `${cards.length} 张卡`}</span>
      </header>

      {message ? (
        <div className={`banner ${messageTone}`} role={messageTone === 'banner--error' ? 'alert' : 'status'}>
          <span>{message}</span>
          <button type="button" className="banner__close" onClick={dismissMessage} aria-label="关闭提示">
            ×
          </button>
        </div>
      ) : null}

      {usingMock ? (
        <p className="notice notice--mock">
          当前是<strong>本地启发式摘要</strong>——在下方「API 设置」里填入 DeepSeek API Key 即可启用真实 AI 总结。
        </p>
      ) : null}

      <main className="app__main">
        <section className="panel panel--input" aria-label="输入通知">
          <SettingsPanel
            settings={settings.settings}
            loading={settings.loading}
            saving={settings.saving}
            onSave={settings.save}
            onClear={settings.clear}
          />
          <IngestForm submitting={submitting} onSubmit={submit} />
        </section>

        <section className="panel panel--list" aria-label="信息卡列表">
          <h2 className="panel__title">信息卡</h2>
          <CardList cards={cards} loading={loading} onDelete={remove} />
        </section>
      </main>
    </div>
  );
}
