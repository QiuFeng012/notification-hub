import type { CardSchedule, HighlightStyle } from '@notification-hub/shared';

/** 日历上的一个日期 */
export interface CalendarDay {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  /** 月份中的第几天 */
  day: number;
  /** 是否今天（按传入的 today 判断，便于测试） */
  isToday: boolean;
}

/** 区间在某一周里的横向占位（列下标 0-6，闭区间） */
export interface ScheduleSpan<T> {
  card: T;
  /** 起始列；区间从更早的周延续过来时固定在 0 */
  startColumn: number;
  /** 结束列；区间延续到下一周时固定在 6 */
  endColumn: number;
  /** 这一周是否就是区间的起始周 */
  startsHere: boolean;
  /** 这一周是否就是区间的结束周 */
  endsHere: boolean;
  /** 区间在本周被边界截断（说明它跨周） */
  clipped: boolean;
  /** 分配到的轨道序号，0 是最上面一条 */
  lane: number;
}

/**
 * 一周的排版结果。
 *
 * 按用户的要求：每个周是若干行——
 *   第 1 行：本周的日期（圆形）
 *   第 2 行起：区间，用「圆—矩形—圆」表示起始与结束
 *   同一周里有区间互相重合时，换到下一行
 * 最后一周不需要填满 7 列：本月只有 4 天就画 4 个圆，不显示下个月的日期。
 */
export interface CalendarWeek<T> {
  /** 本周需要展示的日期；长度可能小于 7（只有首末周会这样） */
  days: CalendarDay[];
  /** 日期在第一行占据的列下标 */
  dayColumns: number[];
  /** 本周总列数 = days.length，用于栅格宽度 */
  columnCount: number;
  /** 每条区间的占位与轨道 */
  spans: Array<ScheduleSpan<T>>;
  /** 轨道数，0 表示本周没有区间，直接只画日期那一行 */
  laneCount: number;
}

/** 简单的字符串哈希，用于给卡片稳定地分配颜色 */
function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

/**
 * 决定某张卡片用哪个颜色画荧光笔。
 *
 * 优先级：用户为这张卡单独指定 > 多日卡按 id 从调色板取色 > 单日默认色。
 * 用 id 哈希而不是数组下标，是为了让颜色只跟卡片绑定：
 * 删除别的卡片不会导致所有卡片换色。
 */
export function resolveCardColor(
  card: { id: string; schedule: CardSchedule | null },
  style: HighlightStyle,
): string {
  const perCard = style.perCard[card.id];
  if (perCard) return perCard;

  const dayCount = card.schedule?.dayCount ?? 1;
  if (dayCount >= 2 && style.multiDayPalette.length > 0) {
    const index = hashString(card.id) % style.multiDayPalette.length;
    return style.multiDayPalette[index] ?? style.singleDay;
  }
  return style.singleDay;
}

/** 把 ISO 日期拆成数字；非法返回 null */
export function splitIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toIso(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** 在某个日期上加减月份，返回新的年月。月份溢出时自动进位到年。 */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const base = new Date(year, month - 1 + delta, 1);
  return { year: base.getFullYear(), month: base.getMonth() + 1 };
}

/** 判断某个日期是否落在日程区间内（闭区间，按字符串比较即可） */
export function isDateInSchedule(date: string, schedule: CardSchedule | null): boolean {
  if (!schedule) return false;
  return date >= schedule.start && date <= schedule.end;
}

/** 没有排期的卡片：这些卡片不会出现在日历上，界面要如实告知数量 */
export function countUnscheduled<T extends { schedule: CardSchedule | null }>(cards: T[]): number {
  return cards.filter((card) => card.schedule === null).length;
}

/**
 * 把某个月的日按周切成行。
 *
 * 只保留本月的日期：首周从 1 号所在的星期开始，末周在月末那天结束。
 * 刻意不显示上个月/下个月的补位日期——用户明确要求"仅显示本月"，
 * 而且补位空格正是之前界面显得空荡的原因。
 *
 * 一周的边界是周一到周日，所以在周六收尾。
 */
function weeksOfMonth(year: number, month: number): Array<{ date: string; day: number }>[] {
  const totalDays = new Date(year, month, 0).getDate();
  const weeks: Array<Array<{ date: string; day: number }>> = [];
  let current: Array<{ date: string; day: number }> = [];

  for (let day = 1; day <= totalDays; day += 1) {
    const weekday = new Date(year, month - 1, day).getDay();
    current.push({ date: toIso(year, month, day), day });
    // 周六（6）收尾，周才是「周一到周日」；
    // 在周日收尾会得到「周二到周一」这种错位的一周。
    // 本月最后一天也要收尾。
    if (weekday === 6 || day === totalDays) {
      weeks.push(current);
      current = [];
    }
  }

  return weeks;
}

export interface BuildMonthOptions<T> {
  year: number;
  month: number;
  today: string;
  cards: T[];
}

/**
 * 生成本月的周排版。
 *
 * 轨道分配用贪心区间图着色：按开始列排序后，每条区间放进第一个
 * "本列之前已空出"的轨道。这样重合的区间一定落在不同行，
 * 而不重合的区间会尽量共用同一行，避免行数虚增。
 */
export function buildMonthWeeks<T extends { id: string; schedule: CardSchedule | null }>(
  options: BuildMonthOptions<T>,
): Array<CalendarWeek<T>> {
  const { year, month, today, cards } = options;
  const rawWeeks = weeksOfMonth(year, month);

  // 只保留与本月有交集的排期。
  // end < start 的区间是坏数据（日期被改坏或解析异常），直接排除——
  // 画出来会横跨整月，比不显示更容易误导。
  const monthStart = toIso(year, month, 1);
  const monthEnd = toIso(year, month, new Date(year, month, 0).getDate());
  const relevant = cards.filter((card) => {
    const schedule = card.schedule;
    if (!schedule) return false;
    if (schedule.end < schedule.start) return false;
    return schedule.start <= monthEnd && schedule.end >= monthStart;
  });

  return rawWeeks.map((week) => {
    const days: CalendarDay[] = week.map((item) => ({
      date: item.date,
      day: item.day,
      isToday: item.date === today,
    }));
    const dayColumns = days.map((_, index) => index);

    // 先把本周可见的区间算成列区间（沿用上一周时起点固定在 0，延续到下周时终点固定在 6）
    const candidates: Array<{ card: T; startColumn: number; endColumn: number; startsHere: boolean; endsHere: boolean }> = [];
    for (const card of relevant) {
      const schedule = card.schedule;
      if (!schedule) continue;

      const first = days[0];
      const last = days[days.length - 1];
      if (!first || !last) continue;
      if (schedule.start > last.date || schedule.end < first.date) continue;

      const startsHere = schedule.start >= first.date;
      const endsHere = schedule.end <= last.date;

      let startColumn = 0;
      let endColumn = days.length - 1;
      if (startsHere) {
        const index = days.findIndex((day) => day.date === schedule.start);
        if (index !== -1) startColumn = index;
      }
      if (endsHere) {
        const index = days.findIndex((day) => day.date === schedule.end);
        if (index !== -1) endColumn = index;
      }
      if (endColumn < startColumn) continue;

      candidates.push({ card, startColumn, endColumn, startsHere, endsHere });
    }

    // 开始列靠前的先分配；同列时区间长的优先，减少碎片
    candidates.sort((a, b) => a.startColumn - b.startColumn || b.endColumn - a.endColumn);

    const laneEnds: number[] = [];
    const spans: Array<ScheduleSpan<T>> = [];
    for (const candidate of candidates) {
      let lane = laneEnds.findIndex((end) => end < candidate.startColumn);
      if (lane === -1) {
        laneEnds.push(candidate.endColumn);
        lane = laneEnds.length - 1;
      } else {
        laneEnds[lane] = candidate.endColumn;
      }
      spans.push({
        card: candidate.card,
        startColumn: candidate.startColumn,
        endColumn: candidate.endColumn,
        startsHere: candidate.startsHere,
        endsHere: candidate.endsHere,
        clipped: !candidate.startsHere || !candidate.endsHere,
        lane,
      });
    }

    return {
      days,
      dayColumns,
      columnCount: days.length,
      spans,
      laneCount: laneEnds.length,
    };
  });
}
