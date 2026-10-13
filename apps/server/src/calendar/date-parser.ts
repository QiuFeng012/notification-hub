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
  /**
   * 这个月是"借"来的：文本里只写了「22号」，没说月份。
   * 供 inferYear 判断用——借来的月份在跨年时需要另行考虑。
   */
  monthOmitted?: boolean;
}

const FULL_DATE = /(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*[日号]?/g;
/**
 * 「10月22日」与「10月22号」都要认。
 *
 * 曾经只认「日」，于是「10月22号（第八周周四）14:30-17:30」里的日期
 * 一个字都读不出来，解析退到星期分支、按锚点那一周算成了 10-15，
 * 差整整七天。中文通知里「号」是最常见的写法之一，不能只认「日」。
 */
const MONTH_DAY = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g;
/** 单独的 M/D，要求两侧不是数字，避免把 14:00 之类的时刻误判成日期 */
const SLASH_DATE = /(?<![\d:])(\d{1,2})\s*[/.]\s*(\d{1,2})(?![\d:])/g;
/**
 * 只有日、没有月份：「22号」「22日」。
 * 月份沿用文本里**最近一个写出来的月份**（例如「10月30号、11月2号」各自跟对月份），
 * 一个都没有时用锚点的月份。
 *
 * 特意排掉「周」前面那个数字：「第八周周四」归一化后是「第8周周四」，
 * 那个 8 是教学周次而不是 8 号。不排掉的话「第八周周四」会被排成 8 号，
 * 等于又在猜日期——而教学周没有学期起始日是算不出来的，这种情况该是"排不上日历"。
 *
 * 另外它只能做到"按字面取日期"：「22号、25号」这种枚举会被读成 22–25 的区间，
 * 而「第8号文件」这种编号会被当成 8 号。前者在通知里本就少见，
 * 后者要区分需要语义判断；两者都是这条规则已知的取舍。
 */
const DAY_ONLY = /(?<![\d])(\d{1,2})\s*[日号](?![周星期])/g;

/**
 * 收集文本中所有显式日期（不含相对日期）。
 *
 * 按"先整段、再月日、后单独日"的顺序把命中的片段替换成空格，
 * 这样同一个日期不会被重复收集。
 *
 * @param anchor 相对日期与年份推断的锚点；单独日的月份也要从它取值，
 *   所以这个函数不再是无状态的纯文本处理
 */
function collectExplicitDates(text: string, anchor: Date): RawDate[] {
  const dates: RawDate[] = [];
  /** 最近一个明确写出的月份，供只有日的写法沿用 */
  let currentMonth: number | null = null;
  const monthOr = (fallback: number) => currentMonth ?? fallback;

  text
    .replace(FULL_DATE, (_match, year: string, month: string, day: string) => {
      const m = Number(month);
      currentMonth = m;
      dates.push({ year: Number(year), month: m, day: Number(day) });
      return ' ';
    })
    .replace(MONTH_DAY, (_match, month: string, day: string) => {
      const m = Number(month);
      currentMonth = m;
      dates.push({ year: null, month: m, day: Number(day) });
      return ' ';
    })
    .replace(DAY_ONLY, (_match, day: string) => {
      const d = Number(day);
      // 日必须像日期；1–31 之外直接丢弃，免得把编号之类的东西当日期
      if (d < 1 || d > 31) return ' ';
      const borrowed = monthOr(anchor.getMonth() + 1);
      dates.push({ year: null, month: borrowed, day: d, monthOmitted: true });
      return ' ';
    })
    .replace(SLASH_DATE, (_match, month: string, day: string) => {
      const m = Number(month);
      const d = Number(day);
      // 只接受像日期的组合，排除 14/2 这类可能是时间的写法之外的噪声
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        currentMonth = m;
        dates.push({ year: null, month: m, day: d });
      }
      return ' ';
    });
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
 *
 * 优先级：显式日期 > 相对日期（今天/明天）> 星期（周五）。
 * 后两者**只在文本里压根没出现日期写法时**才用。这条界线来自一次真实事故：
 * 「10月22号（第八周周四）14:30-17:30」里的日期因为只认「日」没认「号」而解析失败，
 * 于是退到星期分支、按锚点那一周算成了 10-15，而通知写的明明是 10-22。
 * 现在这类写法能被正常解析；万一还有解析不出来的日期写法，
 * 结果会是"排不上日历"（界面会如实告知），而不是一个悄悄错掉的日子。
 */
export function parseSchedule(
  timeText: string | null | undefined,
  options: ParseScheduleOptions,
): DateSchedule | null {
  const raw = (timeText ?? '').trim();
  if (raw.length === 0) return null;

  const text = normalizeDigits(raw);
  const anchor = options.anchor;

  const explicit = collectExplicitDates(text, anchor);
  // 文本里**出现了像日期的写法**，就跟"提到了日子"同义。
  // 这个标记要在逐条校验之前算出来：它记的是"文本提了日期"，
  // 而不是"我们成功解析出了日期"。下面所有兜底分支都要看它——
  // 文本已经写明某个日子时，绝不能用"本周四"之类的推测去顶替。
  const hasExplicitDate = explicit.length > 0;
  const resolved: Date[] = [];
  // 记录每个日期的年份是否为推测所得，下标与 resolved 对齐。
  // 只标记"真正参与区间两端"的那些，而不是"文本里任意一个日期"——
  // 否则「2026年9月28日至9月30日」里那个没写年份的 9月30日
  // 会把整条标记成推测，而区间两端其实都是明确的。
  const resolvedYearInferred: boolean[] = [];

  for (const item of explicit) {
    if (item.month < 1 || item.month > 12) continue;
    if (item.day < 1 || item.day > daysInMonth(item.year ?? anchor.getFullYear(), item.month)) continue;
    const year = item.year ?? inferYear(item.month, item.day, anchor).year;
    resolved.push(new Date(year, item.month - 1, item.day));
    // 年份是推测的，或者月份本身是从别处借来的（只写了「22号」），
    // 界面上都该如实提示"这是推出来的"
    resolvedYearInferred.push(item.year === null || item.monthOmitted === true);
  }

  // 相对日期只在没有显式日期时使用，避免"3月5日（明天）"这种文本产生两个锚点。
  // 这里的 !hasExplicitDate 同时挡住"显式日期解析失败"的情形：
  // 解析失败时 resolved 也是空的，但那不等于"文本没写日期"。
  if (!hasExplicitDate) {
    for (const relative of RELATIVE_DAYS) {
      if (relative.pattern.test(text)) {
        const date = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
        date.setDate(date.getDate() + relative.offset);
        resolved.push(date);
        break;
      }
    }
  }

  // 星期：本周五 / 下周一 等。同样只在文本确实没提日期时才用。
  if (!hasExplicitDate) {
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
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const start = new Date(minTime);
  const end = new Date(maxTime);
  const startIso = toIsoDate(start);
  const endIso = toIsoDate(end);

  // 只有"区间端点所在的那个日期"没写年份时，才需要提示年份是推测的。
  // 相对日期与星期推算本身就依赖锚点，同样算推测。
  const startIndex = times.indexOf(minTime);
  const endIndex = times.indexOf(maxTime);
  const inferredYear =
    resolvedYearInferred.length === 0 ||
    resolvedYearInferred[startIndex] === true ||
    resolvedYearInferred[endIndex] === true;

  return {
    start: startIso,
    end: endIso,
    dayCount: daysBetween(startIso, endIso) + 1,
    label: raw,
    inferredYear,
  };
}
