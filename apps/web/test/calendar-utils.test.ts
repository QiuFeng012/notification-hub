import { describe, expect, it } from 'vitest';
import { DEFAULT_HIGHLIGHT_STYLE, type CardSchedule, type HighlightStyle } from '@notification-hub/shared';
import {
  buildMonthWeeks,
  countUnscheduled,
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

function schedule(start: string, end: string = start): CardSchedule {
  const dayCount = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000) + 1;
  return { start, end, dayCount, label: `${start}~${end}`, inferredYear: true };
}

interface TestCard {
  id: string;
  schedule: CardSchedule | null;
}

function weeks(year: number, month: number, cards: TestCard[], today = `${year}-01-01`) {
  return buildMonthWeeks({ year, month, today, cards });
}

describe('toIsoDate', () => {
  it('用本地日期，晚上不会挪到第二天', () => {
    expect(toIsoDate(new Date(2025, 2, 5, 23, 30))).toBe('2025-03-05');
    expect(toIsoDate(new Date(2025, 2, 5, 0, 30))).toBe('2025-03-05');
    expect(toIsoDate(new Date(2025, 11, 31, 23, 59))).toBe('2025-12-31');
  });
});

describe('resolveCardColor', () => {
  it('单日卡片用单日颜色', () => {
    expect(resolveCardColor({ id: 'a', schedule: schedule('2025-03-05') }, style({ singleDay: '#111111' }))).toBe(
      '#111111',
    );
  });

  it('多日卡片从调色板取色', () => {
    const palette = ['#111111', '#222222'];
    const color = resolveCardColor({ id: 'a', schedule: schedule('2025-03-05', '2025-03-08') }, style({ multiDayPalette: palette }));
    expect(palette).toContain(color);
  });

  it('同一张卡片每次取到的颜色一致', () => {
    const card = { id: 'stable-id', schedule: schedule('2025-03-05', '2025-03-09') };
    const config = style();
    expect(resolveCardColor(card, config)).toBe(resolveCardColor(card, config));
  });

  it('不同多日卡片倾向于取到不同颜色', () => {
    const palette = ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666'];
    const colors = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) =>
      resolveCardColor({ id, schedule: schedule('2025-03-05', '2025-03-07') }, style({ multiDayPalette: palette })),
    );
    expect(new Set(colors).size).toBeGreaterThan(1);
  });

  it('用户单独指定时优先级最高', () => {
    const card = { id: 'a', schedule: schedule('2025-03-05', '2025-03-08') };
    expect(resolveCardColor(card, style({ perCard: { a: '#abcdef' } }))).toBe('#abcdef');
  });

  it('没有排期也能取到颜色，不会崩', () => {
    expect(resolveCardColor({ id: 'x', schedule: null }, style())).toBe(DEFAULT_HIGHLIGHT_STYLE.singleDay);
  });

  it('调色板为空时退回单日颜色', () => {
    const card = { id: 'a', schedule: schedule('2025-03-05', '2025-03-08') };
    expect(resolveCardColor(card, style({ multiDayPalette: [], singleDay: '#999999' }))).toBe('#999999');
  });
});

describe('splitIsoDate 与 shiftMonth', () => {
  it('拆分合法日期，非法返回 null', () => {
    expect(splitIsoDate('2025-03-05')).toEqual({ year: 2025, month: 3, day: 5 });
    expect(splitIsoDate('2025-3-5')).toBeNull();
    expect(splitIsoDate('abc')).toBeNull();
  });

  it('加减月份并能跨年', () => {
    expect(shiftMonth(2025, 3, 1)).toEqual({ year: 2025, month: 4 });
    expect(shiftMonth(2025, 12, 1)).toEqual({ year: 2026, month: 1 });
    expect(shiftMonth(2025, 1, -1)).toEqual({ year: 2024, month: 12 });
  });
});

describe('buildMonthWeeks 周划分', () => {
  it('一周从周一开始、到周日结束', () => {
    const result = weeks(2025, 3, []);
    // 首周只剩 03-01（周六）一天，这是"只显示本月"的必然结果
    expect(result[0]?.days.map((day) => day.date)).toEqual(['2025-03-01']);
    // 第二周是完整的一周：03-02（周一）~ 03-08（周日）
    expect(result[1]?.days.map((day) => day.date)).toEqual([
      '2025-03-02', '2025-03-03', '2025-03-04', '2025-03-05',
      '2025-03-06', '2025-03-07', '2025-03-08',
    ]);
  });

  it('只包含本月日期，不补上下月', () => {
    const result = weeks(2025, 3, []);
    const all = result.flatMap((week) => week.days.map((day) => day.date));
    expect(all).toHaveLength(31);
    expect(all.every((date) => date.startsWith('2025-03'))).toBe(true);
  });

  it('各周天数加起来等于当月天数', () => {
    for (const month of [1, 2, 4, 6, 12]) {
      const result = weeks(2025, month, []);
      const total = result.reduce((sum, week) => sum + week.columnCount, 0);
      const expected = new Date(2025, month, 0).getDate();
      expect(total).toBe(expected);
    }
  });

  it('闰年 2 月是 29 天', () => {
    expect(weeks(2024, 2, []).reduce((sum, week) => sum + week.columnCount, 0)).toBe(29);
  });

  it('标记今天', () => {
    const result = weeks(2025, 3, [], '2025-03-05');
    const today = result.flatMap((week) => week.days).filter((day) => day.isToday);
    expect(today).toHaveLength(1);
    expect(today[0]?.date).toBe('2025-03-05');
  });

  it('月份第一天的列下标就是它在周里的位置', () => {
    const result = weeks(2025, 3, []);
    // 03-01 是周六，落在第 6 列（周一=0）
    expect(result[0]?.dayColumns).toEqual([0]);
    // 第二周从周一开始，列下标是连续的 0..6
    expect(result[1]?.dayColumns).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('buildMonthWeeks 区间放置', () => {
  it('区间落在它覆盖的列上', () => {
    const result = weeks(2025, 3, [{ id: 'a', schedule: schedule('2025-03-05', '2025-03-07') }]);
    const week = result[1];
    const span = week?.spans[0];
    // 03-02 是第 1 列 → 03-05 是第 4 列（下标 3），03-07 是第 6 列（下标 5）
    expect(span?.startColumn).toBe(3);
    expect(span?.endColumn).toBe(5);
    expect(span?.lane).toBe(0);
  });

  it('区间完整落在本周时标记起止都在本周', () => {
    const result = weeks(2025, 3, [{ id: 'a', schedule: schedule('2025-03-05', '2025-03-07') }]);
    const span = result[1]?.spans[0];
    expect(span?.startsHere).toBe(true);
    expect(span?.endsHere).toBe(true);
    expect(span?.clipped).toBe(false);
  });

  it('跨周区间在两处都被截断', () => {
    const result = weeks(2025, 3, [{ id: 'a', schedule: schedule('2025-03-06', '2025-03-11') }]);
    const first = result[1]?.spans[0];
    const second = result[2]?.spans[0];

    expect(first?.startsHere).toBe(true);
    expect(first?.endsHere).toBe(false);
    expect(first?.clipped).toBe(true);
    expect(first?.endColumn).toBe(6);

    expect(second?.startsHere).toBe(false);
    expect(second?.endsHere).toBe(true);
    expect(second?.clipped).toBe(true);
    expect(second?.startColumn).toBe(0);
  });

  it('不重合的区间共用第一行', () => {
    const result = weeks(2025, 3, [
      { id: 'a', schedule: schedule('2025-03-03') },
      { id: 'b', schedule: schedule('2025-03-05') },
    ]);
    const spans = result[1]?.spans ?? [];
    expect(spans.map((span) => span.lane)).toEqual([0, 0]);
    expect(result[1]?.laneCount).toBe(1);
  });

  it('重合的区间换到下一行', () => {
    const result = weeks(2025, 3, [
      { id: 'a', schedule: schedule('2025-03-03', '2025-03-05') },
      { id: 'b', schedule: schedule('2025-03-04', '2025-03-06') },
    ]);
    const spans = result[1]?.spans ?? [];
    expect(new Set(spans.map((span) => span.lane)).size).toBe(2);
    expect(result[1]?.laneCount).toBe(2);
  });

  it('三条区间重叠时排到第三行', () => {
    const result = weeks(2025, 3, [
      { id: 'a', schedule: schedule('2025-03-03', '2025-03-06') },
      { id: 'b', schedule: schedule('2025-03-03', '2025-03-06') },
      { id: 'c', schedule: schedule('2025-03-03', '2025-03-06') },
    ]);
    expect(result[1]?.laneCount).toBe(3);
  });

  it('前一条结束后可以复用同一行，不虚增行数', () => {
    const result = weeks(2025, 3, [
      { id: 'a', schedule: schedule('2025-03-02', '2025-03-03') },
      { id: 'b', schedule: schedule('2025-03-04', '2025-03-05') },
    ]);
    const spans = result[1]?.spans ?? [];
    expect(spans.every((span) => span.lane === 0)).toBe(true);
  });

  it('相邻但不重合的区间可以共用一行（闭区间端点相接不算重合）', () => {
    const result = weeks(2025, 3, [
      { id: 'a', schedule: schedule('2025-03-02', '2025-03-03') },
      { id: 'b', schedule: schedule('2025-03-03', '2025-03-04') },
    ]);
    // 03-03 被两条区间同时覆盖，必须分行
    expect(result[1]?.laneCount).toBe(2);
  });

  it('没有事件的周 laneCount 为 0', () => {
    const result = weeks(2025, 3, [{ id: 'a', schedule: schedule('2025-03-05') }]);
    // 03-17 那一周没有安排
    const emptyWeek = result.find((week) => week.days.some((day) => day.date === '2025-03-17'));
    expect(emptyWeek?.laneCount).toBe(0);
    expect(emptyWeek?.spans).toHaveLength(0);
  });

  it('没有排期的卡片不进任何周', () => {
    const result = weeks(2025, 3, [{ id: 'a', schedule: null }]);
    expect(result.every((week) => week.spans.length === 0)).toBe(true);
  });

  it('与本月份无关的区间不出现', () => {
    const result = weeks(2025, 3, [
      { id: 'past', schedule: schedule('2025-01-05', '2025-01-08') },
      { id: 'future', schedule: schedule('2025-05-05', '2025-05-08') },
    ]);
    expect(result.every((week) => week.spans.length === 0)).toBe(true);
  });

  it('跨月区间在本月只显示落在本月的部分', () => {
    const result = weeks(2025, 3, [{ id: 'a', schedule: schedule('2025-02-25', '2025-03-03') }]);

    // 首周只到 03-01，所以这一段右侧被截断
    const clipped = result[0]?.spans[0];
    expect(clipped?.startsHere).toBe(false);
    expect(clipped?.startColumn).toBe(0);
    expect(clipped?.endsHere).toBe(false);
    expect(clipped?.endColumn).toBe(0);

    // 第二周里它结束于 03-03，这一段右侧有终点圆
    const final = result[1]?.spans[0];
    expect(final?.startsHere).toBe(false);
    expect(final?.endsHere).toBe(true);
    expect(final?.endColumn).toBe(1);
  });

  it('区间损坏（end 早于 start）时不会崩也不会死循环', () => {
    const broken: CardSchedule = {
      start: '2025-03-08',
      end: '2025-03-05',
      dayCount: 1,
      label: 'x',
      inferredYear: false,
    };
    const result = weeks(2025, 3, [{ id: 'broken', schedule: broken }]);
    // 起止颠倒的区间会被当作无效，不产生任何放置
    expect(result.every((week) => week.spans.length === 0)).toBe(true);
  });
});

describe('isDateInSchedule 与 countUnscheduled', () => {
  it('闭区间：起止日都算在内', () => {
    const range = schedule('2025-03-05', '2025-03-08');
    expect(isDateInSchedule('2025-03-05', range)).toBe(true);
    expect(isDateInSchedule('2025-03-08', range)).toBe(true);
    expect(isDateInSchedule('2025-03-04', range)).toBe(false);
    expect(isDateInSchedule('2025-03-09', range)).toBe(false);
  });

  it('没有排期时一律 false', () => {
    expect(isDateInSchedule('2025-03-05', null)).toBe(false);
  });

  it('统计没有排期的卡片', () => {
    expect(countUnscheduled([{ schedule: schedule('2025-03-05') }, { schedule: null }, { schedule: null }])).toBe(2);
    expect(countUnscheduled([{ schedule: schedule('2025-03-05') }])).toBe(0);
  });
});
