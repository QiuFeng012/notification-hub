import type { CardSchedule, CardSortMode } from '@notification-hub/shared';
import { toIsoDate } from './date';

/**
 * 排序需要的最小字段集合。
 *
 * 故意不直接吃 CardView：日历里的卡片也要按同一套规则排，
 * 而日历拿到的可能是别的包装类型。
 */
export interface SortableCard {
  id: string;
  schedule: CardSchedule | null;
  createdAt: string;
  pinned: boolean;
}

/**
 * 排序的档位。
 *
 * 按事件时间排的时候，把列表切成三段而不是整体升序，
 * 因为"最早的排最前"对通知类应用是反的：2026 年 3 月的旧通知会一直压在
 * 明天就截止的通知上面，最该看的东西反而要往下翻。
 *
 * 所以档位是：
 *   0 = 进行中 / 将来（结束日不早于今天）—— 按开始日升序，最紧急的在最上面
 *   1 = 已过期（结束日早于今天）—— 按开始日降序，刚过去的在前
 *   2 = 没有日期 —— 按录入时间降序，排在最下面
 */
type Tier = 0 | 1 | 2;

/**
 * 每种排序方式的一句话说明，直接显示在列表工具栏上。
 *
 * 三种档位的规则不写出来没人猜得到，用户会以为是随手排的。
 */
export const CARD_SORT_HINTS: Record<CardSortMode, string> = {
  event: '临近的在前，已过期的沉到下面，没有日期的排最后',
  created: '最新生成的排在最前',
};

function tierOf(card: SortableCard, today: string): Tier {
  const schedule = card.schedule;
  if (!schedule) return 2;
  return schedule.end < today ? 1 : 0;
}

/**
 * 事件是否已经过去。
 *
 * 按事件时间排的时候"已过期"是一整个档位，界面上必须也标出来：
 * 否则用户看到「日程 9月23日」排在「日程 10月18日」后面会以为排错了。
 */
export function isExpired(card: Pick<SortableCard, 'schedule'>, today: string): boolean {
  return card.schedule !== null && card.schedule.end < today;
}

/** 档位内用来比较的时间键（都是 YYYY-MM-DD 或 ISO 字符串，可直接字典序比较） */
function keyOf(card: SortableCard, tier: Tier): string {
  if (tier === 2) return card.createdAt;
  return card.schedule?.start ?? '';
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 按指定方式给卡片排序，返回新数组（不改动入参）。
 *
 * 共同规则：置顶的卡片永远在所有未置顶卡片之前，置顶组内部按同一套规则排。
 *
 * @param today 本地日期 YYYY-MM-DD，默认取当前时间；测试时注入以获得确定结果
 */
export function sortCards<T extends SortableCard>(
  cards: readonly T[],
  mode: CardSortMode,
  today: string = toIsoDate(new Date()),
): T[] {
  return [...cards].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;

    if (mode === 'created') {
      // 按录入时间：最新录入的在最前
      const byCreated = -compareStrings(a.createdAt, b.createdAt);
      return byCreated !== 0 ? byCreated : compareStrings(a.id, b.id);
    }

    const tierA = tierOf(a, today);
    const tierB = tierOf(b, today);
    if (tierA !== tierB) return tierA - tierB;

    const byKey = compareStrings(keyOf(a, tierA), keyOf(b, tierB));
    // 档位 0 越早越靠前；档位 1、2 越新越靠前
    const ordered = tierA === 0 ? byKey : -byKey;
    return ordered !== 0 ? ordered : compareStrings(a.id, b.id);
  });
}
