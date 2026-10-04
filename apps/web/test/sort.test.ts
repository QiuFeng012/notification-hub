import { describe, expect, it } from 'vitest';
import type { CardSchedule } from '@notification-hub/shared';
import { sortCards, type SortableCard } from '../src/lib/sort';

const TODAY = '2026-10-02';

function schedule(start: string, end: string = start): CardSchedule {
  return { start, end, dayCount: 1, label: start, inferredYear: false };
}

function card(overrides: Partial<SortableCard> & { id: string }): SortableCard {
  return {
    schedule: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    pinned: false,
    ...overrides,
  };
}

/** 排序只关心 id 的顺序，断言时只比 id 更直观 */
function idsOf(cards: SortableCard[]): string[] {
  return cards.map((item) => item.id);
}

describe('sortCards 按事件时间', () => {
  it('将来的排在前，越近越靠前', () => {
    const cards = [
      card({ id: 'far', schedule: schedule('2026-12-01') }),
      card({ id: 'near', schedule: schedule('2026-10-03') }),
      card({ id: 'mid', schedule: schedule('2026-11-10') }),
    ];

    expect(idsOf(sortCards(cards, 'event', TODAY))).toEqual(['near', 'mid', 'far']);
  });

  it('进行中的多日事件（今天夹在区间里）也算临近，排在最前', () => {
    const cards = [
      card({ id: 'tomorrow', schedule: schedule('2026-10-03') }),
      card({ id: 'ongoing', schedule: schedule('2026-09-28', '2026-10-05') }),
    ];

    // 进行中的事件开始日更早，所以排在前面——这正是想要的效果：
    // 还没结束的事情必须比还没开始的事情更显眼。
    expect(idsOf(sortCards(cards, 'event', TODAY))).toEqual(['ongoing', 'tomorrow']);
  });

  it('已过期的沉到将来事件下面，最近过去的在前', () => {
    const cards = [
      card({ id: 'lastMonth', schedule: schedule('2026-09-01') }),
      card({ id: 'yesterday', schedule: schedule('2026-10-01') }),
      card({ id: 'future', schedule: schedule('2026-10-09') }),
    ];

    expect(idsOf(sortCards(cards, 'event', TODAY))).toEqual(['future', 'yesterday', 'lastMonth']);
  });

  it('没有日期的排在所有有日期的后面，按录入时间倒序', () => {
    const cards = [
      card({ id: 'noDateOld', createdAt: '2026-01-01T00:00:00.000Z' }),
      card({ id: 'expired', schedule: schedule('2026-09-01') }),
      card({ id: 'noDateNew', createdAt: '2026-09-30T00:00:00.000Z' }),
      card({ id: 'future', schedule: schedule('2026-10-09') }),
    ];

    expect(idsOf(sortCards(cards, 'event', TODAY))).toEqual([
      'future',
      'expired',
      'noDateNew',
      'noDateOld',
    ]);
  });

  it('结束日就是今天的卡片还没过期', () => {
    const cards = [
      card({ id: 'expired', schedule: schedule('2026-09-20') }),
      card({ id: 'dueToday', schedule: schedule('2026-09-30', '2026-10-02') }),
    ];

    expect(idsOf(sortCards(cards, 'event', TODAY))).toEqual(['dueToday', 'expired']);
  });
});

describe('sortCards 按录入时间', () => {
  it('最新录入的在最前，与有没有日期无关', () => {
    const cards = [
      card({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z', schedule: schedule('2026-10-03') }),
      card({ id: 'new', createdAt: '2026-09-30T00:00:00.000Z' }),
      card({ id: 'mid', createdAt: '2026-05-05T00:00:00.000Z' }),
    ];

    expect(idsOf(sortCards(cards, 'created', TODAY))).toEqual(['new', 'mid', 'old']);
  });
});

describe('sortCards 置顶', () => {
  it('置顶的永远在最前，即使事件时间最晚', () => {
    const cards = [
      card({ id: 'soon', schedule: schedule('2026-10-03') }),
      card({ id: 'pinnedFar', schedule: schedule('2027-06-01'), pinned: true }),
    ];

    expect(idsOf(sortCards(cards, 'event', TODAY))).toEqual(['pinnedFar', 'soon']);
  });

  it('置顶组内部按同一套规则排', () => {
    const cards = [
      card({ id: 'pinnedLate', schedule: schedule('2026-11-01'), pinned: true }),
      card({ id: 'plain', schedule: schedule('2026-10-03') }),
      card({ id: 'pinnedSoon', schedule: schedule('2026-10-05'), pinned: true }),
    ];

    expect(idsOf(sortCards(cards, 'event', TODAY))).toEqual(['pinnedSoon', 'pinnedLate', 'plain']);
  });

  it('按录入时间时置顶同样优先', () => {
    const cards = [
      card({ id: 'newest', createdAt: '2026-09-30T00:00:00.000Z' }),
      card({ id: 'pinnedOld', createdAt: '2026-01-01T00:00:00.000Z', pinned: true }),
    ];

    expect(idsOf(sortCards(cards, 'created', TODAY))).toEqual(['pinnedOld', 'newest']);
  });
});

describe('sortCards 的确定性与纯粹性', () => {
  it('不改动传入的数组', () => {
    const cards = [
      card({ id: 'b', schedule: schedule('2026-11-01') }),
      card({ id: 'a', schedule: schedule('2026-10-03') }),
    ];
    const snapshot = [...cards];

    sortCards(cards, 'event', TODAY);
    expect(idsOf(cards)).toEqual(idsOf(snapshot));
  });

  it('时间键完全相同时按 id 兜底，多次排序结果一致', () => {
    const sameMoment = '2026-09-01T00:00:00.000Z';
    const cards = [
      card({ id: 'bbb', createdAt: sameMoment }),
      card({ id: 'aaa', createdAt: sameMoment }),
      card({ id: 'ccc', createdAt: sameMoment }),
    ];

    const once = idsOf(sortCards(cards, 'created', TODAY));
    const twice = idsOf(sortCards([...cards].reverse(), 'created', TODAY));
    expect(once).toEqual(['aaa', 'bbb', 'ccc']);
    expect(twice).toEqual(once);
  });

  it('空列表返回空列表', () => {
    expect(sortCards([], 'event', TODAY)).toEqual([]);
  });
});
