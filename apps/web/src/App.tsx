import { DEFAULT_HIGHLIGHT_STYLE, isCardSortMode, type CardSortMode } from '@notification-hub/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppHeader } from './components/AppHeader';
import { CalendarView } from './components/CalendarView';
import { CardList } from './components/CardList';
import { IngestForm } from './components/IngestForm';
import { SettingsView } from './components/SettingsView';
import { useCards } from './hooks/useCards';
import { useSettings } from './hooks/useSettings';
import { createCardApi, createSettingsApi } from './lib/api';
import { toIsoDate } from './lib/date';
import { readPageFromLocation, writePageToLocation, type AppPage } from './lib/route';
import { sortCards } from './lib/sort';

/** 信息卡页里的两种视图 */
type CardView = 'list' | 'calendar';

const SORT_STORAGE_KEY = 'notification-hub.sort-mode';
const CARD_VIEW_STORAGE_KEY = 'notification-hub.card-view';

/**
 * 读界面偏好。localStorage 在隐私模式或跨域 iframe 里会直接抛异常，
 * 所以整段包在 try 里——偏好读不出来只是回到默认值，不该让界面白屏。
 */
function readStoredSortMode(): CardSortMode {
  try {
    const value = window.localStorage.getItem(SORT_STORAGE_KEY);
    return isCardSortMode(value) ? value : 'event';
  } catch {
    return 'event';
  }
}

function readStoredCardView(): CardView {
  try {
    return window.localStorage.getItem(CARD_VIEW_STORAGE_KEY) === 'calendar' ? 'calendar' : 'list';
  } catch {
    return 'list';
  }
}

/**
 * 应用外壳：三个页面 + 常驻页头。
 *
 *   #/          首页：标题 + 通知输入
 *   #/cards     信息卡收集页：卡片列表 / 日历视图
 *   #/settings  设置：API 调用（+ 两个待实现的分组）
 *
 * 页面状态同时存在 React state 和地址栏 hash 里，hash 是初始来源。
 * 多一份状态是为了让刷新、后退、独立应用里重新打开都能回到原页面。
 *
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

  const { cards, loading, submitting, error, dismissError, submit, lastCreatedId, edit, revisions, clearRevisions, togglePin, remove } =
    useCards(cardApi);
  const settings = useSettings(settingsClient);
  const [page, setPage] = useState<AppPage>(readPageFromLocation);
  const [cardView, setCardView] = useState<CardView>(readStoredCardView);
  const [sortMode, setSortMode] = useState<CardSortMode>(readStoredSortMode);

  const todayIso = today ?? toIsoDate(new Date());
  const highlight = settings.settings?.highlight ?? DEFAULT_HIGHLIGHT_STYLE;
  const scheduledCount = cards.filter((card) => card.schedule !== null).length;

  // 排序只在这里做一次：顶部计数、列表、日历都读同一份结果，才不会出现两处顺序不一致
  const sortedCards = useMemo(() => sortCards(cards, sortMode, todayIso), [cards, sortMode, todayIso]);

  /** 切换页面：state 与地址栏一起改，后退键才有东西可退 */
  const navigate = useCallback((next: AppPage) => {
    setPage(next);
    writePageToLocation(next);
  }, []);

  // 后退/前进改的是 hash，这里把 state 跟回去；否则地址变了界面不动
  useEffect(() => {
    const syncFromHash = () => setPage(readPageFromLocation());
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);

  const changeSort = useCallback((mode: CardSortMode) => {
    setSortMode(mode);
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, mode);
    } catch {
      // 存不下就只当次生效，不值得为此打断用户
    }
  }, []);

  const changeCardView = useCallback((view: CardView) => {
    setCardView(view);
    try {
      window.localStorage.setItem(CARD_VIEW_STORAGE_KEY, view);
    } catch {
      // 同上
    }
  }, []);

  // 两类提示共用一个位置：错误优先，其次是保存结果
  const message = error ?? settings.error ?? settings.notice;
  const messageTone = error || settings.error ? 'banner--error' : 'banner--ok';
  const dismissMessage = () => {
    if (error) dismissError();
    else settings.dismiss();
  };

  const usingMock = settings.settings !== null && !settings.settings.configured;

  // 首页提交完看不到卡片列表了，所以要把"刚才生成了什么"说清楚，
  // 并给一个去信息卡页的入口——否则粘贴完一条通知，界面上什么都没发生。
  const lastCreated = lastCreatedId ? cards.find((card) => card.id === lastCreatedId) ?? null : null;

  return (
    <div className={`app app--${page}`}>
      <AppHeader
        page={page}
        cardCount={loading ? null : cards.length}
        scheduledCount={scheduledCount}
        calendarOpen={cardView === 'calendar'}
        onNavigate={navigate}
      />

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
          当前是<strong>本地启发式摘要</strong>——在
          <button type="button" className="notice__link" onClick={() => navigate('settings')}>
            设置页
          </button>
          里填入 DeepSeek API Key 即可启用真实 AI 总结。
        </p>
      ) : null}

      <main className="app__main">
        {page === 'home' ? (
          <div className="home">
            <section className="panel panel--ingest" aria-label="输入通知">
              <IngestForm submitting={submitting} onSubmit={submit} />
            </section>

            {lastCreated ? (
              <p className="home__result" role="status">
                <span className="home__result-text">
                  已生成信息卡《{lastCreated.title}》
                </span>
                <button type="button" className="button button--ghost" onClick={() => navigate('cards')}>
                  去信息卡页查看
                </button>
              </p>
            ) : null}
          </div>
        ) : null}

        {page === 'cards' ? (
          <section className="panel panel--list" aria-label={cardView === 'calendar' ? '日历视图' : '信息卡列表'}>
            {/* 这里不再重复写一个「信息卡」标题：页头右上角的导航按钮
                已经标出了当前在哪一页，再加一行只是噪声 */}
            <div className="view-switch">
              <div className="view-switch__tabs" role="tablist" aria-label="视图切换">
                <button
                  type="button"
                  role="tab"
                  aria-selected={cardView === 'list'}
                  className={cardView === 'list' ? 'view-tab view-tab--active' : 'view-tab'}
                  onClick={() => changeCardView('list')}
                >
                  卡片列表
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={cardView === 'calendar'}
                  className={cardView === 'calendar' ? 'view-tab view-tab--active' : 'view-tab'}
                  onClick={() => changeCardView('calendar')}
                >
                  日历视图
                </button>
              </div>
            </div>

            {cardView === 'list' ? (
              <CardList
                cards={sortedCards}
                loading={loading}
                onEdit={async (id, patch) => (await edit(id, patch)) !== null}
                onLoadRevisions={revisions}
                onClearRevisions={clearRevisions}
                onTogglePin={togglePin}
                onDelete={remove}
                sortMode={sortMode}
                onChangeSort={changeSort}
                highlightId={lastCreatedId}
                today={todayIso}
              />
            ) : (
              <CalendarView
                cards={sortedCards}
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
        ) : null}

        {page === 'settings' ? (
          <SettingsView
            settings={settings.settings}
            loading={settings.loading}
            saving={settings.saving}
            onSave={settings.save}
            onClear={settings.clear}
          />
        ) : null}
      </main>
    </div>
  );
}
