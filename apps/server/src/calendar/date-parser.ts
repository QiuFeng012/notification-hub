/**
 * 从通知的时间文本里解析出结构化日期范围。
 *
 * 为什么要有这一层：卡片存的 `time` 是自由文本（"3月8日24:00前"），
 * 日历需要知道"这张卡落在哪几天"。让模型直接吐日期是不可靠的——
 * 它可能编造，而编造的日期比"解析不出来"危险得多。
 * 所以这里用确定性规则解析，解析不出来就明确标记为无法排期，
 * 日历上不显示，而不是猜一个位置放上去。
 */

/** YYYY-MM-DD 形式的本地日期 */
export type IsoDate = string;

export interface DateSchedule {
  /** 起始日期（含） */
  start: IsoDate;
  /** 结束日期（含）；单日卡片与 start 相同 */
  end: IsoDate;
  /** 覆盖天数，等于 end - start + 1 */
  dayCount: number;
  /** 解析所依据的原文本，便于界面解释"为什么排在这天" */
  label: string;
  /**
   * 是否为推测所得。
   * true 表示文本里没有完整年份，年份是按卡片创建时间推断的，
   * 跨年场景下可能偏一年，界面上会提示。
   */
  inferredYear: boolean;
}

/** 中文数字 → 阿拉伯数字，处理"三月八日"这类写法 */
const CHINESE_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function parseChineseNumber(text: string): number | null {
  if (text.length === 0) return null;
  // 纯阿拉伯数字
  if (/^\d+$/.test(text)) return Number(text);

  // 十 / 十一 / 二十 / 二十三 / 三十一
  const tenIndex = text.indexOf('十');
  if (tenIndex !== -1) {
    const tens = tenIndex === 0 ? 1 : CHINESE_DIGITS[text.slice(0, tenIndex)] ?? null;
    const onesText = text.slice(tenIndex + 1);
    const ones = onesText.length === 0 ? 0 : CHINESE_DIGITS[onesText] ?? null;
    if (tens === null || ones === null) return null;
    return tens * 10 + ones;
  }

  // 单字或连续单字组合（如"二三"不做支持，直接判失败）
  if (text.length === 1) return CHINESE_DIGITS[text] ?? null;
  return null;
}

/** 把文本里的中文数字替换成阿拉伯数字，便于统一处理 */
function normalizeDigits(text: string): string {
  return text
    .replace(/[零一二三四五六七八九十]+/g, (match) => {
      const value = parseChineseNumber(match);
      return value === null ? match : String(value);
    })
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10));
}

interface RawDate {
  month: number;
  day: number;
  year: number | null;
}

const FULL_DATE = /(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?/g;
const MONTH_DAY = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
/** 单独的 M/D，要求两侧不是数字，避免把 14:00 之类的时刻误判成日期 */
const SLASH_DATE = /(?<![\d:])(\d{1,2})\s*[/.]\s*(\d{1,2})(?![\d:])/g;

/** 收集文本中所有显式日期（不含相对日期） */
function collectExplicitDates(text: string): RawDate[] {
  const dates: RawDate[] = [];
  const remaining = text
    .replace(FULL_DATE, (_match, year: string, month: string, day: string) => {
      dates.push({ year: Number(year), month: Number(month), day: Number(day) });
      return ' ';
    })
    .replace(MONTH_DAY, (_match, month: string, day: string) => {
      dates.push({ year: null, month: Number(month), day: Number(day) });
      return ' ';
    })
    .replace(SLASH_DATE, (_match, month: string, day: string) => {
      const m = Number(month);
      const d = Number(day);
      // 只接受像日期的组合，排除 14/2 这类可能是时间的写法之外的噪声
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) dates.push({ year: null, month: m, day: d });
      return ' ';
    });
  void remaining;
  return dates;
}

/** 把 IsoDate 解析成 {year, month, day}；格式不合法返回 null */
export function parseIsoDate(value: IsoDate): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** 本地日期转 IsoDate。刻意不用 toISOString——那会按 UTC 偏移把日期挪一天。 */
export function toIsoDate(date: Date): IsoDate {
  const pad = (num: number) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** IsoDate 相加减天数，返回新的 IsoDate */
export function addDays(value: IsoDate, days: number): IsoDate {
  const parts = parseIsoDate(value);
  if (!parts) return value;
  const date = new Date(parts.year, parts.month - 1, parts.day);
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}

/** 两个 IsoDate 之间相差的天数（b - a），按本地日历日计算 */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  const left = parseIsoDate(a);
  const right = parseIsoDate(b);
  if (!left || !right) return 0;
  const start = new Date(left.year, left.month - 1, left.day).getTime();
  const end = new Date(right.year, right.month - 1, right.day).getTime();
  return Math.round((end - start) / 86_400_000);
}

/** 该月的天数；月份非法时返回 0 */
export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  return new Date(year, month, 0).getDate();
}

/**
 * 推断年份。
 *
 * 通知里的日期通常不写年份。以卡片创建时间为锚点：
 * 若解析出的月日比创建日早了半年以上，几乎可以肯定是明年的安排（跨年通知）。
 * 这一层只是"尽量不排错"，结果会带 inferredYear 标记，界面上如实提示。
 */
function inferYear(month: number, day: number, anchor: Date): { year: number; inferred: boolean } {
  const anchorYear = anchor.getFullYear();
  const candidate = new Date(anchorYear, month - 1, day);
  const halfYearMs = 183 * 86_400_000;
  if (candidate.getTime() < anchor.getTime() - halfYearMs) {
    return { year: anchorYear + 1, inferred: true };
  }
  return { year: anchorYear, inferred: true };
}

/** 相对日期：今天/明天/后天/大后天 */
const RELATIVE_DAYS: Array<{ pattern: RegExp; offset: number }> = [
  { pattern: /大后天/, offset: 3 },
  { pattern: /后天/, offset: 2 },
  { pattern: /明天|次日/, offset: 1 },
  { pattern: /今天|今日|当天/, offset: 0 },
];

/** 星期：周一…周日 */
const WEEKDAY_PATTERN = /(?:下周|周|星期|礼拜)([一二三四五六日天1-7])/;
const WEEKDAY_INDEX: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
};

export interface ParseScheduleOptions {
  /** 解析锚点，通常是卡片的创建时间；用于相对日期与年份推断 */
  anchor: Date;
}

/**
 * 从时间文本解析出日程范围。
 *
 * 解析不出任何日期时返回 null——这**不是**失败，而是诚实地说"这条排不上日历"。
 * 猜一个日期放上去会让人误以为那是真的安排，比不显示糟得多。
 */
export function parseSchedule(
  timeText: string | null | undefined,
  options: ParseScheduleOptions,
): DateSchedule | null {
  const raw = (timeText ?? '').trim();
  if (raw.length === 0) return null;

  const text = normalizeDigits(raw);
  const anchor = options.anchor;

  const explicit = collectExplicitDates(text);
  const resolved: Date[] = [];

  for (const item of explicit) {
    if (item.month < 1 || item.month > 12) continue;
    if (item.day < 1 || item.day > daysInMonth(item.year ?? anchor.getFullYear(), item.month)) continue;
    const year = item.year ?? inferYear(item.month, item.day, anchor).year;
    resolved.push(new Date(year, item.month - 1, item.day));
  }

  // 相对日期只在没有显式日期时使用，避免"3月5日（明天）"这种文本产生两个锚点
  if (resolved.length === 0) {
    for (const relative of RELATIVE_DAYS) {
      if (relative.pattern.test(text)) {
        const date = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
        date.setDate(date.getDate() + relative.offset);
        resolved.push(date);
        break;
      }
    }
  }

  // 星期：本周五 / 下周一 等。仅在没有其他日期时使用
  if (resolved.length === 0) {
    const weekdayMatch = WEEKDAY_PATTERN.exec(text);
    const weekday = weekdayMatch?.[1] ? WEEKDAY_INDEX[weekdayMatch[1]] : undefined;
    if (weekday !== undefined) {
      const isNextWeek = /下周/.test(text);
      const date = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
      const current = date.getDay() === 0 ? 7 : date.getDay();
      let delta = weekday - current;
      if (isNextWeek) delta += 7;
      // 本周已过的星期视为下周，而不是排到过去
      else if (delta < 0) delta += 7;
      date.setDate(date.getDate() + delta);
      resolved.push(date);
    }
  }

  if (resolved.length === 0) return null;

  const times = resolved.map((date) => date.getTime());
  const start = new Date(Math.min(...times));
  const end = new Date(Math.max(...times));
  const startIso = toIsoDate(start);
  const endIso = toIsoDate(end);

  return {
    start: startIso,
    end: endIso,
    dayCount: daysBetween(startIso, endIso) + 1,
    label: raw,
    inferredYear: explicit.some((item) => item.year === null),
  };
}
