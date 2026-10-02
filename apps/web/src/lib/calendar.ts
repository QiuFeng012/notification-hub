import type { CardSchedule, HighlightStyle } from '@notification-hub/shared';

/** 日历上的一个日期格 */
export interface CalendarCell {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  /** 该日属于当前月份（跨月补位的格子为 false） */
  inMonth: boolean;
  /** 月份中的第几天 */
  day: number;
  /** 是否今天（按传入的 today 判断，便于测试） */
  isToday: boolean;
}

/** 简单的字符串哈希，用于给卡片稳定地分配调色板颜色 */
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

/**
 * 生成某个月的日历网格。
 *
 * 每行以周一开头（国内日历习惯），首尾用相邻月份的日期补满整周，
 * 避免出现参差不齐的网格。
 */
export function buildMonthGrid(year: number, month: number, today: string): CalendarCell[] {
  const firstOfMonth = new Date(year, month - 1, 1);
  // getDay(): 周日=0。换算成周一=1…周日=7
  const weekdayOfFirst = firstOfMonth.getDay() === 0 ? 7 : firstOfMonth.getDay();
  const leading = weekdayOfFirst - 1;

  const totalDays = new Date(year, month, 0).getDate();
  const totalCells = Math.ceil((leading + totalDays) / 7) * 7;

  const cells: CalendarCell[] = [];
  for (let index = 0; index < totalCells; index += 1) {
    const offset = index - leading;
    const date = new Date(year, month - 1, 1 + offset);
    const dateIso = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    cells.push({
      date: dateIso,
      inMonth: date.getMonth() === month - 1,
      day: date.getDate(),
      isToday: dateIso === today,
    });
  }
  return cells;
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

/**
 * 把卡片按日期铺进日历。
 * 日程覆盖的每一天都会出现在结果里，所以多日卡片会在它占用的每一格上重复出现。
 */
export function groupCardsByDate<T extends { id: string; schedule: CardSchedule | null }>(
  cards: T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();

  for (const card of cards) {
    const schedule = card.schedule;
    if (!schedule) continue;

    const start = splitIsoDate(schedule.start);
    const end = splitIsoDate(schedule.end);
    if (!start || !end) continue;

    const cursor = new Date(start.year, start.month - 1, start.day);
    const last = new Date(end.year, end.month - 1, end.day);
    // 防御：损坏的区间可能让循环跑很久，限制在一年内
    let guard = 0;
    while (cursor.getTime() <= last.getTime() && guard < 400) {
      const dateIso = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
      const bucket = map.get(dateIso);
      if (bucket) bucket.push(card);
      else map.set(dateIso, [card]);
      cursor.setDate(cursor.getDate() + 1);
      guard += 1;
    }
  }

  return map;
}

/** 没有排期的卡片：这些卡片不会出现在日历上，界面要如实告知数量 */
export function countUnscheduled<T extends { schedule: CardSchedule | null }>(cards: T[]): number {
  return cards.filter((card) => card.schedule === null).length;
}
