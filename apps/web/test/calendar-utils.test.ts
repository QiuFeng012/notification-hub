import { describe, expect, it } from 'vitest';
import { DEFAULT_HIGHLIGHT_STYLE, type HighlightStyle } from '@notification-hub/shared';
import type { CardSchedule } from '@notification-hub/shared';
import {
  buildMonthGrid,
  countUnscheduled,
  groupCardsByDate,
  isDateInSchedule,
  resolveCardColor,
  shiftMonth,
  splitIsoDate,
} from '../src/lib/calendar';
import { toIsoDate } from '../src/lib/date';

function style(overrides: Partial<HighlightStyle> = {}): HighlightStyle {
  return {
    singleDay: DEFAULT_HIGHLIGHT_STYLE.singleDay,
    multiDayPalette: [...DEFAULT_HIGHLIGHT_STYLE.multiDayPalette],
    perCard: {},
    ...overrides,
  };
}

function schedule(start: string, end = start): CardSchedule {
  const dayCount =
    Math.round(
      (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000,
    ) + 1;
  return { start, end, dayCount, label: `${start}~${end}`, inferredYear: true };
}

describe('toIsoDate', () => {
  it('用本地日期，晚上不会挪到第二天', () => {
    // 用 toISOString 会在东八区把 3月5日 23:30 变成 3月5日 15:30（UTC），反之亦然
    expect(toIsoDate(new Date(2025, 2, 5, 23, 30))).toBe('2025-03-05');
    expect(toIsoDate(new Date(2025, 2, 5, 0, 30))).toBe('2025-03-05');
    expect(toIsoDate(new Date(2025, 11, 31, 23, 59))).toBe('2025-12-31');
  });
});

describe('resolveCardColor', () => {
  it('单日卡片用单日颜色', () => {
    const card = { id: 'card-a', schedule: schedule('2025-03-05') };
    expect(resolveCardColor(card, style({ singleDay: '#111111' }))).toBe('#111111');
  });

  it('多日卡片从调色板取色', () => {
    const card = { id: 'card-a', schedule: schedule('2025-03-05', '2025-03-08') };
    const palette = ['#111111', '#222222'];
    expect(palette).toContain(resolveCardColor(card, style({ multiDayPalette: palette })));
  });

  it('同一张卡片每次取到的颜色一致', () => {
    const card = { id: 'stable-id', schedule: schedule('2025-03-05', '2025-03-09') };
    const config = style();
    expect(resolveCardColor(card, config)).toBe(resolveCardColor(card, config));
  });

  it('不同多日卡片倾向于取到不同颜色', () => {
    const palette = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666'];
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const colors = ids.map((id) =>
      resolveCardColor({ id, schedule: schedule('2025-03-05', '2025-03-07') }, style({ multiDayPalette: palette })),
    );
    // 不要求完美均分，但绝不能所有卡片都同一个颜色
    expect(new Set(colors).size).toBeGreaterThan(1);
  });

  it('用户为某张卡单独指定时优先级最高', () => {
    const card = { id: 'card-a', schedule: schedule('2025-03-05', '2025-03-08') };
    const config = style({ perCard: { 'card-a': '#abcdef' } });
    expect(resolveCardColor(card, config)).toBe('#abcdef');
  });

  it('没有排期的卡片也能取到颜色（不会崩）', () => {
    expect(resolveCardColor({ id: 'x', schedule: null }, style())).toBe(DEFAULT_HIGHLIGHT_STYLE.singleDay);
  });

  it('调色板为空时退回单日颜色，不会返回 undefined', () => {
    const card = { id: 'card-a', schedule: schedule('2025-03-05', '2025-03-08') };
    expect(resolveCardColor(card, style({ multiDayPalette: [], singleDay: '#999999' }))).toBe('#999999');
  });
});

describe('splitIsoDate', () => {
  it('拆分合法日期', () => {
    expect(splitIsoDate('2025-03-05')).toEqual({ year: 2025, month: 3, day: 5 });
  });

  it('非法输入返回 null', () => {
    expect(splitIsoDate('2025-3-5')).toBeNull();
    expect(splitIsoDate('')).toBeNull();
    expect(splitIsoDate('abc')).toBeNull();
  });
});

describe('buildMonthGrid', () => {
  it('2025 年 3 月从周一开头，共 42 格（6 行）', () => {
    // 2025-03-01 是周六，所以前面补 5 格（周一到周五）
    const cells = buildMonthGrid(2025, 3, '2025-03-05');
    expect(cells).toHaveLength(42);
    expect(cells[0]?.date).toBe('2025-02-24');
    expect(cells[5]?.date).toBe('2025-03-01');
    expect(cells[5]?.inMonth).toBe(true);
  });

  it('标记当月与补位格', () => {
    const cells = buildMonthGrid(2025, 3, '2025-03-05');
    const inMonth = cells.filter((cell) => cell.inMonth);
    expect(inMonth).toHaveLength(31);
    expect(inMonth[0]?.date).toBe('2025-03-01');
    expect(inMonth[30]?.date).toBe('2025-03-31');
  });

  it('标记今天', () => {
    const cells = buildMonthGrid(2025, 3, '2025-03-05');
    const today = cells.filter((cell) => cell.isToday);
    expect(today).toHaveLength(1);
    expect(today[0]?.date).toBe('2025-03-05');
  });

  it('跨年边界正确：2026 年 1 月', () => {
    const cells = buildMonthGrid(2026, 1, '2026-01-15');
    const inMonth = cells.filter((cell) => cell.inMonth);
    expect(inMonth).toHaveLength(31);
    expect(inMonth[0]?.date).toBe('2026-01-01');
    // 1 月 1 日是周四，所以前面补 3 格（2025-12-29 起）
    expect(cells[0]?.date).toBe('2025-12-29');
  });

  it('闰年 2 月有 29 天', () => {
    const cells = buildMonthGrid(2024, 2, '2024-02-01').filter((cell) => cell.inMonth);
    expect(cells).toHaveLength(29);
    expect(cells[28]?.date).toBe('2024-02-29');
  });

  it('每个月都是整周（格数能被 7 整除）', () => {
    for (let month = 1; month <= 12; month += 1) {
      expect(buildMonthGrid(2025, month, '2025-06-01').length % 7).toBe(0);
    }
  });
});

describe('shiftMonth', () => {
  it('加减月份', () => {
    expect(shiftMonth(2025, 3, 1)).toEqual({ year: 2025, month: 4 });
    expect(shiftMonth(2025, 3, -1)).toEqual({ year: 2025, month: 2 });
  });

  it('跨年进位', () => {
    expect(shiftMonth(2025, 12, 1)).toEqual({ year: 2026, month: 1 });
    expect(shiftMonth(2025, 1, -1)).toEqual({ year: 2024, month: 12 });
  });
});

describe('isDateInSchedule', () => {
  it('闭区间：起止日都算在内', () => {
    const range = schedule('2025-03-05', '2025-03-08');
    expect(isDateInSchedule('2025-03-05', range)).toBe(true);
    expect(isDateInSchedule('2025-03-06', range)).toBe(true);
    expect(isDateInSchedule('2025-03-08', range)).toBe(true);
    expect(isDateInSchedule('2025-03-04', range)).toBe(false);
    expect(isDateInSchedule('2025-03-09', range)).toBe(false);
  });

  it('没有排期时一律 false', () => {
    expect(isDateInSchedule('2025-03-05', null)).toBe(false);
  });
});

describe('groupCardsByDate', () => {
  it('多日卡片铺满其覆盖的每一天', () => {
    const cards = [
      { id: 'multi', schedule: schedule('2025-03-05', '2025-03-08') },
      { id: 'single', schedule: schedule('2025-03-06') },
    ];
    const map = groupCardsByDate(cards);

    expect(map.get('2025-03-05')?.map((card) => card.id)).toEqual(['multi']);
    expect(map.get('2025-03-06')?.map((card) => card.id)).toEqual(['multi', 'single']);
    expect(map.get('2025-03-08')?.map((card) => card.id)).toEqual(['multi']);
    expect(map.has('2025-03-09')).toBe(false);
  });

  it('没有排期的卡片不进日历', () => {
    const map = groupCardsByDate([{ id: 'none', schedule: null }]);
    expect(map.size).toBe(0);
  });

  it('同一天的多张卡片都保留', () => {
    const cards = [
      { id: 'a', schedule: schedule('2025-03-05') },
      { id: 'b', schedule: schedule('2025-03-05') },
    ];
    expect(groupCardsByDate(cards).get('2025-03-05')).toHaveLength(2);
  });

  it('跨月区间正确铺开', () => {
    const map = groupCardsByDate([{ id: 'cross', schedule: schedule('2025-03-30', '2025-04-02') }]);
    expect(map.has('2025-03-30')).toBe(true);
    expect(map.has('2025-03-31')).toBe(true);
    expect(map.has('2025-04-01')).toBe(true);
    expect(map.has('2025-04-02')).toBe(true);
    expect(map.size).toBe(4);
  });

  it('区间损坏（end 早于 start）时不会死循环', () => {
    const broken: CardSchedule = { start: '2025-03-08', end: '2025-03-05', dayCount: 1, label: 'x', inferredYear: false };
    const map = groupCardsByDate([{ id: 'broken', schedule: broken }]);
    expect(map.size).toBe(0);
  });
});

describe('countUnscheduled', () => {
  it('统计没有排期的卡片', () => {
    const cards = [
      { schedule: schedule('2025-03-05') },
      { schedule: null },
      { schedule: null },
    ];
    expect(countUnscheduled(cards)).toBe(2);
  });

  it('全都有排期时返回 0', () => {
    expect(countUnscheduled([{ schedule: schedule('2025-03-05') }])).toBe(0);
  });
});
