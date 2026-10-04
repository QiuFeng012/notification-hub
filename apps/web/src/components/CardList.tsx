import { CARD_SORT_LABELS, type CardRevision, type CardSortMode, type UpdateCardRequest } from '@notification-hub/shared';
import { CardItem } from './CardItem';
import type { CardView } from '../lib/card-view';
import { CARD_SORT_HINTS } from '../lib/sort';

interface CardListProps {
  cards: CardView[];
  loading: boolean;
  /** 提交修改；返回是否成功 */
  onEdit: (id: string, patch: UpdateCardRequest) => Promise<boolean>;
  onLoadRevisions: (id: string) => Promise<CardRevision[]>;
  onClearRevisions: (id: string) => Promise<void>;
  /** 置顶 / 取消置顶 */
  onTogglePin: (id: string, pinned: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** 当前排序方式 */
  sortMode: CardSortMode;
  onChangeSort: (mode: CardSortMode) => void;
  /** 刚生成的那张卡；会被滚进视野并闪一下，其他时候为 null */
  highlightId: string | null;
  /** 今天，格式 YYYY-MM-DD；用于标出已过期的卡片、给跨年日程补上年份 */
  today: string;
}

/** 排序方式的先后顺序（也是界面上按钮的排列顺序） */
const SORT_MODES: CardSortMode[] = ['event', 'created'];

/**
 * 信息卡列表。
 *
 * 排序不在这里做：排序结果由 App 统一算出后传进来，
 * 因为顶部的计数、日历视图都要和列表顺序一致，算两遍迟早会分叉。
 */
export function CardList({
  cards,
  loading,
  onEdit,
  onLoadRevisions,
  onClearRevisions,
  onTogglePin,
  onDelete,
  sortMode,
  onChangeSort,
  highlightId,
  today,
}: CardListProps) {
  if (loading) {
    return (
      <div className="state state--loading" role="status">
        正在读取历史信息卡…
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="state state--empty">
        <p className="state__title">还没有信息卡</p>
        <p className="state__desc">把收到的通知粘贴到左侧输入栏，点「生成信息卡」就会出现在这里。</p>
      </div>
    );
  }

  return (
    <div className="card-list-wrap">
      <div className="list-toolbar">
        <span className="list-toolbar__hint" data-testid="sort-hint">
          {CARD_SORT_HINTS[sortMode]}
        </span>
        <div className="list-toolbar__sorts" role="group" aria-label="排序方式">
          {SORT_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={mode === sortMode ? 'sort-tab sort-tab--active' : 'sort-tab'}
              aria-pressed={mode === sortMode}
              onClick={() => onChangeSort(mode)}
            >
              {CARD_SORT_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>

      <div className="card-list">
        {cards.map((card) => (
          <CardItem
            key={card.id}
            card={card}
            onEdit={onEdit}
            onLoadRevisions={onLoadRevisions}
            onClearRevisions={onClearRevisions}
            onTogglePin={onTogglePin}
            onDelete={onDelete}
            highlighted={card.id === highlightId}
            today={today}
          />
        ))}
      </div>
    </div>
  );
}
