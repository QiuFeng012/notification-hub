import type { AppPage } from '../lib/route';

interface AppHeaderProps {
  page: AppPage;
  /** 信息卡总数；加载中为 null，避免闪一个 0 出来 */
  cardCount: number | null;
  /** 日历上能排的卡片数，只在信息卡页显示 */
  scheduledCount: number;
  /** 当前在信息卡页的哪个视图，用于词条上的说明文字 */
  calendarOpen: boolean;
  onNavigate: (page: AppPage) => void;
}

/**
 * 全站页头：左边是标题（点击回首页），右上角常驻「信息卡」与「设置」。
 *
 * 标题在首页放大、副标题只在首页出现：首页的职责就是把"这里是干什么的"
 * 说清楚；切到别的页面之后，标题退成一个回首页的入口就够了，
 * 不该继续占着最显眼的位置。
 */
export function AppHeader({
  page,
  cardCount,
  scheduledCount,
  calendarOpen,
  onNavigate,
}: AppHeaderProps) {
  const onHome = page === 'home';

  return (
    <header className={onHome ? 'app__header app__header--home' : 'app__header'}>
      <div className="app__brand">
        <h1 className="app__title">
          <button type="button" className="app__title-button" onClick={() => onNavigate('home')}>
            信息整合台
          </button>
        </h1>
        {onHome ? (
          <p className="app__subtitle">粘贴通知 → AI 提炼要点 → 生成信息卡，数据只存在本机</p>
        ) : null}
      </div>

      <nav className="app__nav" aria-label="主导航">
        <button
          type="button"
          className={page === 'cards' ? 'nav-button nav-button--active' : 'nav-button'}
          aria-current={page === 'cards' ? 'page' : undefined}
          onClick={() => onNavigate('cards')}
        >
          信息卡
          <span className="nav-button__count" data-testid="nav-card-count">
            {cardCount === null ? '—' : calendarOpen ? `${scheduledCount} 条有日期` : `${cardCount} 张`}
          </span>
        </button>

        <button
          type="button"
          className={page === 'settings' ? 'nav-button nav-button--active' : 'nav-button'}
          aria-current={page === 'settings' ? 'page' : undefined}
          onClick={() => onNavigate('settings')}
          aria-label="设置"
        >
          设置
        </button>
      </nav>
    </header>
  );
}
