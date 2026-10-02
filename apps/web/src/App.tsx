import { DEFAULT_HIGHLIGHT_STYLE } from '@notification-hub/shared';
import { useMemo, useState } from 'react';
import { CalendarView } from './components/CalendarView';
import { CardList } from './components/CardList';
import { IngestForm } from './components/IngestForm';
import { SettingsPanel } from './components/SettingsPanel';
import { useCards } from './hooks/useCards';
import { useSettings } from './hooks/useSettings';
import { createCardApi, createSettingsApi } from './lib/api';
import { toIsoDate } from './lib/date';

type ViewMode = 'cards' | 'calendar';

/**
 * 应用外壳：左侧输入栏 + API 设置，右侧在「卡片列表」与「日历视图」间切换。
 * 通过 props 传入 api 是为了在组件测试里注入替身，无需真的发请求。
 */
export interface AppProps {
  api?: ReturnType<typeof createCardApi>;
  settingsApi?: ReturnType<typeof createSettingsApi>;
  /** 今天，格式 YYYY-MM-DD；注入是为了让日历相关测试结果确定 */
  today?: string;
}

export default function App({ api, settingsApi, today }: AppProps = {}) {
  const cardApi = useMemo(() => api ?? createCardApi(), [api]);
  const settingsClient = useMemo(() => settingsApi ?? createSettingsApi(), [settingsApi]);

  const { cards, loading, submitting, error, dismissError, submit, edit, revisions, clearRevisions, remove } =
    useCards(cardApi);
  const settings = useSettings(settingsClient);
  const [view, setView] = useState<ViewMode>('cards');

  const todayIso = today ?? toIsoDate(new Date());
  const highlight = settings.settings?.highlight ?? DEFAULT_HIGHLIGHT_STYLE;
  const scheduledCount = cards.filter((card) => card.schedule !== null).length;

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
        <span className="app__badge">
          {loading ? '—' : view === 'calendar' ? `${scheduledCount} 条有日期` : `${cards.length} 张卡`}
        </span>
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

        <section className="panel panel--list" aria-label={view === 'calendar' ? '日历视图' : '信息卡列表'}>
          <div className="view-switch">
            <h2 className="panel__title">信息卡</h2>
            <div className="view-switch__tabs" role="tablist" aria-label="视图切换">
              <button
                type="button"
                role="tab"
                aria-selected={view === 'cards'}
                className={view === 'cards' ? 'view-tab view-tab--active' : 'view-tab'}
                onClick={() => setView('cards')}
              >
                卡片列表
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={view === 'calendar'}
                className={view === 'calendar' ? 'view-tab view-tab--active' : 'view-tab'}
                onClick={() => setView('calendar')}
              >
                日历视图
              </button>
            </div>
          </div>

          {view === 'cards' ? (
            <CardList
              cards={cards}
              loading={loading}
              onEdit={async (id, patch) => (await edit(id, patch)) !== null}
              onLoadRevisions={revisions}
              onClearRevisions={clearRevisions}
              onDelete={remove}
            />
          ) : (
            <CalendarView
              cards={cards}
              loading={loading}
              highlight={highlight}
              onSaveHighlight={settings.save}
              onEdit={async (id, patch) => (await edit(id, patch)) !== null}
              onLoadRevisions={revisions}
              onClearRevisions={clearRevisions}
              today={todayIso}
            />
          )}
        </section>
      </main>
    </div>
  );
}
