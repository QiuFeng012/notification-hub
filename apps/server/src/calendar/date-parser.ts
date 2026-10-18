/**
 * 从通知的时间文本里解析出结构化日期范围。
 *
 * 为什么要有这一层：卡片存的 `time` 是自由文本（"3月8日24:00前"），
 * 日历需要知道"这张卡落在哪几天"。让模型直接吐日期是不可靠的——
 * 它可能编造，而编造的日期比"解析不出来"危险得多。
 * 所以这里用确定性规则解析，解析不出来就明确标记为无法排期，
 * 日历上不显示，而不是猜一个位置放上去。
 *
 * 除了 parseSchedule（单条，供 time 文本用），这里还有 buildSchedules：
 * 一条通知可能同时给"报名截止"和"活动开始"两个时间，那需要拆成多条日程。
 */

import type { CardSchedule, ScheduleRole } from '@notification-hub/shared';

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
  /**
   * 这条日程扮演的角色：报名截止 / 活动 / 到场 / 无归属。
   * 界面用它给同一张卡的不同日程加标签，否则两条颜色相同的条分不清谁是谁。
   */
  role?: ScheduleRole;
  /**
   * 起始时刻 HH:mm；文本里没有可靠时刻时为 null。
   * 只允许 00:00–23:59；24:00 只允许出现在 endTime。
   */
  startTime?: string | null;
  /** 截止时刻 HH:mm；24:00 表示当天结束 */
  endTime?: string | null;
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

/**
 * 把文本里的中文数字替换成阿拉伯数字，便于统一处理。
 *
 * **只转换紧挨着 月/日/号 的那些**（「三月八日」「二十二号」），不碰别处的汉字。
 * 这条限制是必需的，不是洁癖：中文里好几个汉字与数字同形——
 * 「于3月5日」的「于」被当成五、「至3月8日」的「至」被当成十，
 * 替换后会粘成「53月5日」「103月8日」，后面的日期就全读错了
 * （实测过：「3月5日至3月8日」被算成 3-05 与 3-18 两个莫名其妙的日期）。
 *
 * 做法：命中的中文数字与紧随其后的 月/日/号 之间插入一个分隔符 `·`，
 * 既挡住了与前后数字的粘连，又不影响后续正则识别；用完立刻把 `·` 去掉
 * （见 stripNumSeparator），后面的正则不必为它做任何特殊处理。
 * 全角数字单独处理，它没有歧义。
 */
function normalizeDigits(text: string): string {
  return text
    .replace(/([零一二三四五六七八九十]+)(?=\s*[月日号])/g, (match) => {
      const value = parseChineseNumber(match);
      return value === null ? match : `${value}·`;
    })
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10));
}

/** 去掉归一化时插入的分隔符，让下游正则只面对干净的数字 */
function stripNumSeparator(text: string): string {
  return text.replace(NUM_SEPARATOR, '');
}

/**
 * 把省略后半月份的区间写法展开成完整写法。
 *
 * 通知里常写「10月17-18日」「10月17、18日」「10月17至18日」——后半截只说日、
 * 不说月。不展开的话只有「18日」能被识别（前面那个 17 没有"月"），
 * 区间就丢了前半段，而月日之间那个连字符还会被当成别的东西。
 *
 * 展开成「10月17日-10月18日」之后，既有的"同一个小句里的多个日期合成区间"
 * 逻辑就直接适用了，不必在解析层再写一套区间规则。
 */
function expandAbbreviatedRanges(text: string): string {
  return text
    .replace(
      /(\d{1,2})月\s*(\d{1,2})\s*[日号]?\s*[-~—－至到、,，]\s*(\d{1,2})\s*[日号]/g,
      (_match, month: string, startDay: string, endDay: string) =>
        `${month}月${startDay}日-${month}月${endDay}日`,
    )
    .replace(
      /(\d{1,2})月\s*(\d{1,2})\s*[日号]\s*[-~—－至到]\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/g,
      (_match, m1: string, d1: string, m2: string, d2: string) => `${m1}月${d1}日-${m2}月${d2}日`,
    );
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
  /**
   * 这个日期在**归一化后的文本**里的起始下标。
   * buildSchedules 靠它把日期与它所在小句里的关键词对上，
   * 从而判断"这个日子属于报名截止还是活动"。
   */
  at?: number;
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
/** 中文数字与 月/日/号 之间插入的分隔符，只在这一层用，别的正则要能容忍它 */
const NUM_SEPARATOR = /·/g;

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

  // 先把所有形态的匹配都收集起来，带位置；再按位置顺序处理。
  //
  // 顺序很关键：只能有日的写法（「22号」）要沿用"它前面最近写出的那个月份"。
  // 早先按正则逐个扫全串的做法把这个上下文丢了——「10月30号、11月2号」里
  // 第二个日期会拿到错误的月份。所以顺序与位置必须一起处理。
  type Pending = { at: number; length: number; kind: 'full' | 'monthDay' | 'dayOnly' | 'slash'; parts: number[] };
  const pending: Pending[] = [];

  /**
   * 逐个匹配并**就地记下 match.index**，而不是先替换再 indexOf 找回位置。
   *
   * 这一点踩过坑：原实现是 `text.replace(re, (m) => { dates.push({..., at: text.indexOf(m)}); return ' ' })`，
   * 但 replace 是**边匹配边改字符串**的，后面的 indexOf 是在已被改短的文本上找，
   * 位置全错。当时的表现是「问卷截止时间：2026年10月14日」里的日期被判到
   * "时间"附近而不是"截止"附近，于是报名截止被认成了活动。
   */
  const collect = (pattern: RegExp, kind: Pending['kind'], pick: (match: RegExpExecArray) => number[]) => {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const parts = pick(match);
      // match[0] 必须在**这次**迭代里取出来：exec 是复用的同一个数组对象，
      // 下一次 exec 会把它原地改掉，事后再读就全串了
      const length = match[0].length;
      if (parts.length > 0) {
        pending.push({ at: match.index, length, kind, parts });
      }
      match = pattern.exec(text);
    }
  };

  collect(FULL_DATE, 'full', (match) => [Number(match[1]), Number(match[2]), Number(match[3])]);
  collect(MONTH_DAY, 'monthDay', (match) => [Number(match[1]), Number(match[2])]);
  collect(DAY_ONLY, 'dayOnly', (match) => [Number(match[1])]);
  collect(SLASH_DATE, 'slash', (match) => {
    const m = Number(match[1]);
    const d = Number(match[2]);
    // 只接受像日期的组合，排除 14/2 这类可能是时间的写法之外的噪声
    return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? [m, d] : [];
  });

  // 同一处可能被多个正则命中：「2026年10月22号」既被 FULL_DATE 匹配，
  // 里面的「22号」又会被 DAY_ONLY 匹配到。后者会带出"月份是借来的"这个错误结论
  // （明明写了 2026年10月），所以必须去重。
  //
  // 去重规则：**按优先级排序后、位置重叠的丢掉**。优先级 = 信息量：
  // FULL_DATE（带年份） > MONTH_DAY（带月份） > SLASH_DATE > DAY_ONLY（只有日）。
  // 位置重叠即视为同一个日期——这比"位置完全相同"更稳，因为各正则的 match.index
  // 分别指向「2026」与「22号」，起点本来就不同。
  // 同一段文字只允许被**一个**正则认领，认领过的地方后面的正则不再看。
  //
  // 这是原实现（逐个正则 replace 成空格）隐含的语义，我改成"分别扫描"时丢了它，
  // 结果「10月22号」里的「22号」又被 DAY_ONLY 认了一遍、
  // 「3月5日至3月8日」里的「5日」与「10」也被二次认领，
  // 冒出 2025-03-05、2025-03-18 这种凭空多出来的日期。
  //
  // 处理顺序 = 优先级：FULL_DATE（带年份）> MONTH_DAY（带月）> SLASH_DATE > DAY_ONLY。
  // 先认领的赢，后面的跳过与之重叠的片段。
  const priority: Record<Pending['kind'], number> = { full: 0, monthDay: 1, slash: 2, dayOnly: 3 };
  const ordered = [...pending].sort((a, b) => priority[a.kind] - priority[b.kind] || a.at - b.at);

  const claimed: Array<{ start: number; end: number }> = [];
  const overlaps = (start: number, end: number) =>
    claimed.some((span) => start < span.end && span.start < end);

  // 收集到的日期按**原文位置**排序后输出：年份与月份的沿用必须按阅读顺序，
  // 否则「10月30号、11月2号」里第二个日期会拿到错误的月份
  const accepted: Pending[] = [];
  for (const item of ordered) {
    const end = item.at + item.length;
    if (overlaps(item.at, end)) continue;
    claimed.push({ start: item.at, end });
    accepted.push(item);
  }
  accepted.sort((a, b) => a.at - b.at);

  for (const item of accepted) {
    if (item.kind === 'full') {
      const [year, month, day] = item.parts as [number, number, number];
      currentMonth = month;
      dates.push({ year, month, day, at: item.at });
      continue;
    }
    if (item.kind === 'monthDay') {
      const [month, day] = item.parts as [number, number];
      currentMonth = month;
      dates.push({ year: null, month, day, at: item.at });
      continue;
    }
    if (item.kind === 'slash') {
      const [month, day] = item.parts as [number, number];
      currentMonth = month;
      dates.push({ year: null, month, day, at: item.at });
      continue;
    }
    const [day] = item.parts as [number];
    // 日必须像日期；1–31 之外直接丢弃，免得把编号之类的东西当日期
    if (day < 1 || day > 31) continue;
    const borrowed = monthOr(anchor.getMonth() + 1);
    dates.push({ year: null, month: borrowed, day, monthOmitted: true, at: item.at });
  }

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
 * 把原文切成小句，用来就近判断一个日期属于哪件事。
 *
 * 按标点切而不是按句子切：通知经常写成
 * 「请于9月23日12:30前报名，9月24日15:00活动举行」——
 * 逗号前后的两个日期扮演的角色完全不同，不切开就会判成同一类。
 */
function splitClauses(text: string): string[] {
  return text
    .split(/[。；;，,！!？?\n\r]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/**
 * 「报名截止」这一类：需要在某个时间点之前完成的事。
 *
 * 刻意不放「前完成」「前交」这类通用说法——它们与"活动时间"常常出现在同一句
 * （「请于9月23日前报名，9月24日活动举行」），当标志用反而会抢走活动的时间。
 * 只留语义明确的词。
 */
const DEADLINE_KEYWORDS = ['截止', '之前', '报名', '提交', '填写', '申请', '反馈', '完成'];
/**
 * 「活动」这一类：什么时候真正发生。
 *
 * **没有「时间」这个词**：它是泛指——「问卷截止时间」里的"时间"紧贴日期，
 * 若当作活动标志就会把"报名截止"认成"活动"，报名截止日反而消失。
 * 只留真正的动词与场景词。
 */
const ACTIVITY_KEYWORDS = ['举行', '活动', '开始', '开放', '进行', '召开', '举办', '当天', '现场'];
/** 「到场」这一类：体检、检查、考试这类需要到场的安排 */
const VISIT_KEYWORDS = ['体检', '检查', '考核', '考试', '面试', '采集'];

/** 是否像"标题行"：以「时间/截止/日期」这类词收尾，如「⏰检查时间：」 */
function isHeading(clause: string): boolean {
  return /(时间|截止|日期|安排)\s*[：:]?\s*$/.test(clause.trim());
}

/** 某个小句里最靠后的关键词位置；没有则返回 -1 */
function lastKeywordIndex(clause: string, keywords: string[]): number {  let best = -1;
  for (const keyword of keywords) {
    const index = clause.lastIndexOf(keyword);
    if (index > best) best = index;
  }
  return best;
}

/**
 * 判断一个小句里的日期扮演什么角色。
 *
 * 两类关键词都出现时（"9月23日前报名，9月24日活动举行"被切成一句的少见情况），
 * 取**离日期最近**的那个关键词所属的类别——"谁离它近，它就属于谁"，
 * 比按固定优先级判更接近人读通知的方式。
 *
 * 都没出现时返回 primary：从 time 文本解析出的单一日期就是这一类，
 * 界面上不额外加标签。
 */
function classifyRole(clause: string, dateIndexInClause: number): ScheduleRole {
  const deadline = lastKeywordIndex(clause, DEADLINE_KEYWORDS);
  const activity = lastKeywordIndex(clause, ACTIVITY_KEYWORDS);
  const visit = lastKeywordIndex(clause, VISIT_KEYWORDS);
  const candidates: Array<{ role: ScheduleRole; distance: number }> = [];
  if (deadline >= 0) candidates.push({ role: 'deadline', distance: Math.abs(deadline - dateIndexInClause) });
  if (activity >= 0) candidates.push({ role: 'activity', distance: Math.abs(activity - dateIndexInClause) });
  if (visit >= 0) candidates.push({ role: 'visit', distance: Math.abs(visit - dateIndexInClause) });
  if (candidates.length === 0) {
    /**
     * 一条没有关键词时的兜底：**日期后面紧跟「前」就是截止**。
     *
     * 「10月20号（下周二）16：00前完成」「10月20号前交到值班台」这类句子
     * 未必带"截止/提交"字样，但语义上就是"这天之前要办完"。
     * 只在没有其他关键词时才用，避免抢走"活动时间"那类句子。
     * 窗口给到 20 字：「10月20号（下周二）下午16：00前完成」里的「前」
     * 离日期有十几个字，窗口太窄会漏掉——实测就漏过一次。
     */
    const after = clause.slice(dateIndexInClause, dateIndexInClause + 20);
    if (/前/.test(after)) return 'deadline';
    return 'primary';
  }
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0]?.role ?? 'primary';
}

/** 一个时刻 token：分钟数 + 在归一化文本里的位置 + 时段词 */
interface ClockToken {
  minutes: number;
  index: number;
  endIndex: number;
  /** 只有真正带「下午/晚上/凌晨」这类词时才存在；区间第二个时刻通常没有 */
  period?: string;
}

/** 两个时刻之间只允许出现这些区间连接符 */
const CLOCK_RANGE_SEPARATOR = /^[-~—－至到]$/;

/** 全角数字与全角冒号归一化；与日期归一化分开，避免影响「月/日」的识别 */
function normalizeClockText(text: string): string {
  return text
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))
    .replace(/：/g, ':');
}

/** 1440 分钟显示成 24:00，其余补零成 HH:mm */
function formatClockMinutes(minutes: number): string {
  if (minutes >= 1440) return '24:00';
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** 按时段词修正小时；「中午1点」按 13:00 理解 */
function adjustClockHour(hour: number, period: string | undefined): number {
  if (!period) return hour;
  if (['下午', '晚上', '傍晚', '夜里', '夜间'].includes(period) && hour < 12) return hour + 12;
  if (period === '中午' && (hour === 1 || hour === 2)) return hour + 12;
  if (['凌晨', '早上', '上午'].includes(period) && hour === 12) return 0;
  return hour;
}

/** 把一个正则命中转换成 ClockToken；非法时刻返回 null */
function clockTokenFrom(
  match: RegExpMatchArray,
  options: { chinese: boolean; colon: boolean },
): ClockToken | null {
  const index = match.index ?? 0;
  const period = match[1];
  const hourText = match[2];
  if (!hourText) return null;

  const hour = options.chinese ? parseChineseNumber(hourText) : Number(hourText);
  if (hour === null || !Number.isInteger(hour)) return null;

  const minuteText = match[3];
  let minute = 0;
  if (options.colon) {
    minute = Number(minuteText);
  } else if (match[0].includes('半')) {
    minute = 30;
  } else if (minuteText) {
    const parsed = options.chinese ? parseChineseNumber(minuteText) : Number(minuteText);
    if (parsed === null) return null;
    minute = parsed;
  }

  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (hour === 24 && minute === 0) {
    return {
      minutes: 1440,
      index,
      endIndex: index + match[0].length,
      ...(period ? { period } : {}),
    };
  }
  if (hour < 0 || hour > 23) return null;

  const adjusted = adjustClockHour(hour, period);
  return {
    minutes: adjusted * 60 + minute,
    index,
    endIndex: index + match[0].length,
    ...(period ? { period } : {}),
  };
}

/**
 * 收集文本里的时刻。
 *
 * 只认带冒号或「点/时」的写法——「3-8」「2026」「10月22日」里的数字
 * 都不是时刻，误认会把日期变成时间。
 */
function collectClockTokens(text: string): ClockToken[] {
  const normalized = normalizeClockText(text);
  const patterns: Array<{ regex: RegExp; chinese: boolean; colon: boolean }> = [
    {
      regex: /(上午|下午|中午|晚上|凌晨|早上|傍晚|夜里|夜间)?\s*(\d{1,2})\s*:\s*(\d{2})/g,
      chinese: false,
      colon: true,
    },
    {
      regex:
        /(上午|下午|中午|晚上|凌晨|早上|傍晚|夜里|夜间)?\s*(\d{1,2})\s*[点时](?:\s*(\d{1,2})\s*分?|\s*半)?/g,
      chinese: false,
      colon: false,
    },
    {
      regex:
        /(上午|下午|中午|晚上|凌晨|早上|傍晚|夜里|夜间)?\s*([零一二三四五六七八九十]{1,3})\s*[点时](?:\s*([零一二三四五六七八九十]{1,3})\s*分?|\s*半)?/g,
      chinese: true,
      colon: false,
    },
  ];

  const tokens: ClockToken[] = [];
  const seen = new Set<number>();
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    for (const match of normalized.matchAll(pattern.regex)) {
      const token = clockTokenFrom(match, pattern);
      if (!token || seen.has(token.index)) continue;
      seen.add(token.index);
      tokens.push(token);
    }
  }
  return tokens.sort((a, b) => a.index - b.index);
}

/** 文本里是否至少有一个可识别的时刻 */
function hasClockTokens(text: string): boolean {
  return collectClockTokens(normalizeClockText(text)).length > 0;
}

/** 「办公时间 9:00-17:00」是上下文，不该单独变成一件当天的事 */
function isOfficeHoursClause(text: string): boolean {
  if (!/(办公|工作|营业)/.test(text)) return false;
  return collectClockTokens(normalizeClockText(text)).length >= 2;
}

/**
 * 区间第二个时刻常常省略时段词：「下午三点到五点」「晚上7点-9点」。
 * 第一个时刻带了下午/晚上时，把同组的第二个时刻也按下午/晚上理解。
 */
function applyRangePeriod(first: ClockToken, last: ClockToken): number {
  const period = first.period;
  if (!period || last.period) return last.minutes;
  const endHour = Math.floor(last.minutes / 60);
  if (['下午', '晚上', '傍晚', '夜里', '夜间'].includes(period) && endHour < 12) {
    return last.minutes + 12 * 60;
  }
  // 「晚上7点到12点」里的 12 点是当天结束，不是中午
  if (
    ['下午', '晚上', '傍晚', '夜里', '夜间'].includes(period) &&
    endHour === 12 &&
    last.minutes === 12 * 60
  ) {
    return 1440;
  }
  if (period === '中午' && (endHour === 1 || endHour === 2)) {
    return last.minutes + 12 * 60;
  }
  return last.minutes;
}

/** 相邻两个时刻之间只有区间连接符时，归为同一组 */
function groupClockTokens(tokens: ClockToken[], text: string): ClockToken[][] {
  const groups: ClockToken[][] = [];
  for (const token of tokens) {
    const current = groups[groups.length - 1];
    const previous = current?.[current.length - 1];
    if (!current || !previous) {
      groups.push([token]);
      continue;
    }
    const between = text.slice(previous.endIndex, token.index).replace(/\s+/g, '');
    if (CLOCK_RANGE_SEPARATOR.test(between)) current.push(token);
    else groups.push([token]);
  }
  return groups;
}

/**
 * 取与日期最近的一组时刻，并按角色分配到起止端。
 *
 * 锚点是日期在句中的位置：优先取日期之后最近的一组，日期之后没有
 * 才取日期之前最近的一组。这样「14:30开始，3月5日活动」与
 * 「3月5日14:30-17:30」都能拿到正确的一组，而不会跨句乱挂。
 */
function clockFieldsFor(
  text: string,
  anchorIndex: number,
  role: ScheduleRole,
): { startTime: string | null; endTime: string | null } {
  const normalized = normalizeClockText(text);
  const tokens = collectClockTokens(normalized);
  if (tokens.length === 0) return { startTime: null, endTime: null };

  const groups = groupClockTokens(tokens, normalized);
  const after = groups.find((group) => (group[0]?.index ?? 0) >= anchorIndex);
  const before = [...groups]
    .reverse()
    .find((group) => (group[group.length - 1]?.endIndex ?? 0) <= anchorIndex);
  const chosen = after ?? before;
  const first = chosen?.[0];
  const last = chosen?.[chosen.length - 1];
  if (!first || !last) return { startTime: null, endTime: null };

  const start = first.minutes;
  const end = applyRangePeriod(first, last);

  if (role === 'deadline') {
    return { startTime: null, endTime: formatClockMinutes(end) };
  }
  if (chosen.length === 1) {
    if (start >= 1440) return { startTime: null, endTime: '24:00' };
    return { startTime: formatClockMinutes(start), endTime: null };
  }
  if (start >= 1440) return { startTime: null, endTime: '24:00' };
  if (end < start) return { startTime: formatClockMinutes(start), endTime: null };
  return { startTime: formatClockMinutes(start), endTime: formatClockMinutes(end) };
}

/**
 * 把一组已解析的日期合成一条日程（取最早与最晚）
 *
 * clockText / clockAnchor 是时刻解析的文本与日期位置；默认用 label 与 0，
 * 便于只关心日期的调用方不改签名。
 */
function toSchedule(
  dates: Date[],
  yearInferred: boolean[],
  label: string,
  role: ScheduleRole,
  clockText: string = label,
  clockAnchor: number = 0,
): DateSchedule {
  const times = dates.map((date) => date.getTime());
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const startIndex = times.indexOf(minTime);
  const endIndex = times.indexOf(maxTime);
  const startIso = toIsoDate(new Date(minTime));
  const endIso = toIsoDate(new Date(maxTime));
  return {
    start: startIso,
    end: endIso,
    dayCount: daysBetween(startIso, endIso) + 1,
    label,
    // 只有区间端点所在的那个日期没写年份时才算"推测"，不被文中别处连累
    inferredYear:
      yearInferred.length === 0 || yearInferred[startIndex] === true || yearInferred[endIndex] === true,
    role,
    ...clockFieldsFor(clockText, clockAnchor, role),
  };
}

/**
 * 把一段原文拆成多条日程。
 *
 * 解决的问题：很多通知同时给两个时间——"9月23日12:30开始报名"与
 * "9月24日15:00活动举行"。它们不是一段时间的两端，而是一早一晚两件事。
 * 原先只取所有日期的最早与最晚合成一条，日历上就把这两天连同中间一起涂成
 * 一个连续区间，看起来像"活动持续两天"。现在按角色拆成各自的一条。
 *
 * 规则全是确定性的，不依赖模型：
 *   1. 按标点切成小句；
 *   2. 解析每个小句里的日期，并按句内关键词判角色（谁离日期近就归谁）；
 *   3. 同一角色合到一条（报名区间、活动时段各自成条），不同角色分开；
 *   4. 只有一类角色时，退化成原来的单条日程，行为与从前一致。
 *
 * 返回空数组表示"排不上日历"，与 parseSchedule 返回 null 同义。
 */
export function buildSchedules(
  text: string | null | undefined,
  options: BuildSchedulesOptions,
): DateSchedule[] {
  return buildSchedulesWithMeta(text, options).schedules;
}

/** buildSchedules 的入参；timeText 是卡片的时间字段，用来指出哪件是主日程 */
export interface BuildSchedulesOptions extends ParseScheduleOptions {
  /**
   * 卡片 time 字段的文本，用来指出"哪一件是主日程"。
   *
   * 模型已经把 time 提炼成一个具体日期，那通常就是这张卡最主要的时间
   * （图像采集通知给的是采集日，而不是表格截止日）。没有它时退到
   * "报名/截止优先、再取最早的"。
   */
  timeText?: string | null;
}

interface BuildSchedulesMetaOptions extends BuildSchedulesOptions {
  /**
   * 原文这条主日程已经有时刻时，是否仍用 time 字段的时刻覆盖它。
   *
   * 创建/回填时不需要——原文本就写着时刻就听原文的；用户改了时间字段时
   * 才需要，因为那才是"现在正确"的时间。
   */
  overrideClocks?: boolean;
}

interface BuildSchedulesResult {
  schedules: DateSchedule[];
  /**
   * 主日程是不是 time 字段单独给的（原文里没有与它对应的那一条）。
   *
   * 用户把时间改到原文没写的日期时，靠它判断"旧主日程已经被取代"。
   */
  primaryFromTimeHint: boolean;
}

function buildSchedulesWithMeta(
  text: string | null | undefined,
  options: BuildSchedulesMetaOptions,
): BuildSchedulesResult {
  const raw = (text ?? '').trim();
  if (raw.length === 0) return { schedules: [], primaryFromTimeHint: false };

  const anchor = options.anchor;

  // 第一层：逐句解析，每句一条候选（同句里的多个日期是"这件事的两端"，合到一条）
  const merged: DateSchedule[] = [];
  /**
   * 上一句若是"标题行"，记下它的角色供紧接的日期行继承。
   *
   * 通知里常见这种写法：
   *     ⏰检查时间：
   *      10月22号（第八周周四）
   * 标题行本身没有日期，日期行本身没有关键词。两者合起来才是完整的一句话。
   * **只认标题行**（以「时间/截止/日期」结尾的那种），不认任意上一句——
   * 否则「…大会将于10月22日召开」会把后面无关的日期也染成"活动"，
   * 实测出现过：卫检的「16:00前交表」被邻居的"活动"带跑。
   */
  let labelRole: ScheduleRole | null = null;
  /** 最近一句出现过的日期；给「16:00前提交」这种省略日期的后续句继承 */
  let lastDates: Date[] | null = null;
  let lastInferred: boolean[] = [];

  const clauses = splitClauses(raw);
  for (let clauseIndex = 0; clauseIndex < clauses.length; clauseIndex += 1) {
    const clause = clauses[clauseIndex] ?? '';
    // 先归一化中文数字、再去掉防粘连的分隔符：
    // 「于3月5日」不能被换成「53月5日」，否则日期全读错
    const normalized = expandAbbreviatedRanges(stripNumSeparator(normalizeDigits(clause)));
    const dates: Date[] = [];
    const inferred: boolean[] = [];

    for (const item of collectExplicitDates(normalized, anchor)) {
      if (item.month < 1 || item.month > 12) continue;
      if (item.day < 1 || item.day > daysInMonth(item.year ?? anchor.getFullYear(), item.month)) continue;
      const year = item.year ?? inferYear(item.month, item.day, anchor).year;
      dates.push(new Date(year, item.month - 1, item.day));
      inferred.push(item.year === null || item.monthOmitted === true);
    }

    // 这个小句里没有显式日期写法时才考虑相对日期与星期，理由同 parseSchedule
    if (dates.length === 0) {
      const fallback = relativeOrWeekday(normalized, anchor);
      if (fallback) {
        dates.push(fallback);
        inferred.push(true);
      }
    }
    if (dates.length === 0) {
      const heading = classifyRole(normalized, 0);
      // 标题行：没有日期，但可能替下一句说明了这是什么时间
      if (isHeading(normalized)) {
        labelRole = heading !== 'primary' ? heading : null;
        continue;
      }
      // 日期省略、但角色和时刻明确的后续句：「3月5日9:00-17:00办公，16:00前提交」。
      // 只继承非 primary 的角色，避免把任意一句都当成新事件。
      if (lastDates && heading !== 'primary' && hasClockTokens(normalized)) {
        const carried = toSchedule(lastDates, lastInferred, clause, heading, normalized, 0);
        if (carried.startTime || carried.endTime) merged.push(carried);
      }
      labelRole = null;
      continue;
    }

    lastDates = dates;
    lastInferred = inferred;

    // 角色取句内离第一个日期最近的那类关键词
    const first = collectExplicitDates(normalized, anchor)[0];
    const own = classifyRole(normalized, first?.at ?? 0);
    // 自己判不出来时，才借用紧邻的标题行；用完即清，不影响更远的句子
    const role: ScheduleRole = own !== 'primary' ? own : (labelRole ?? 'primary');
    labelRole = null;

    // 办公时间只是上下文：后面紧跟着另一条带时刻的安排时，不要把它画成事件，
    // 否则「办公室 9-17 点」会顶掉真正的 16:00 截止。
    const next = clauses[clauseIndex + 1];
    if (isOfficeHoursClause(normalized) && next && hasClockTokens(next)) {
      continue;
    }

    merged.push(toSchedule(dates, inferred, clause, role, normalized, first?.at ?? 0));
  }
  if (merged.length === 0) return { schedules: [], primaryFromTimeHint: false };

  // 第二层：同一角色里**真正重叠**的合并成一条。
  //
  // 判据是"重叠"，不是"相接"：相接会把「3月5日开放…3月8日截止」里的
  // 5 日与 8 日粘成 3-05~3-08 一条（那是对的），但也会把
  // 「9月23日报名…9月24日活动」粘成一条（那是错的——它们是两件事）。
  // 重叠则能区分开：前者的多个日期本来就落在同一个区间语义里，
  // 后者的两个日期互相不重叠。
  //
  // 同一句式里的多个日期（「10月17-18日体检」）在切句时就被合成一个区间了
  // （见 expandAbbreviatedRanges 与同句内取最早最晚），所以这里不必再靠"相接"兜。
  const byRole = new Map<ScheduleRole, DateSchedule[]>();
  for (const item of merged) {
    const role = item.role ?? 'primary';
    const list = byRole.get(role) ?? [];
    const overlapping = list.find((existing) => schedulesOverlap(existing, item));
    if (overlapping) {
      byRole.set(role, [...list.filter((entry) => entry !== overlapping), mergeTwo(overlapping, item)]);
    } else {
      list.push(item);
      byRole.set(role, list);
    }
  }

  // "当天""当日"这类相对词会被解析成卡片创建那天，而原文里它往往指的是别处的
  // 某个具体日子（"卫检当天"）。这种候选不是独立的一件事，留下只会在创建日上
  // 多出一条没有意义的安排。
  //
  // 判据必须是"**用了相对词**"，而不是"日期刚好落在创建日"——后者会把
  // 「3月5日14:00开放」这种写明日期的正常安排一起误杀
  // （卡片若创建于 3 月 5 日，那一天的活动就凭空消失了）。
  const dropRelativeAnchor = (list: DateSchedule[]) =>
    list.filter((item) => !/(当天|当日)/.test(item.label));
  const deadlineAll = dropRelativeAnchor(byRole.get('deadline') ?? []);
  const activityAll = dropRelativeAnchor(byRole.get('activity') ?? []);
  const visitAll = dropRelativeAnchor(byRole.get('visit') ?? []);
  /**
   * 同一角色内部把**相接或重叠**的区间并起来，而不是简单取最早与最晚。
   *
   * 区别很实在：体检通知里「莞城10月11日」「松山湖10月17-18日」是两段分开的安排，
   * 取最早最晚会得到 10-11~10-18 连续八天；按相接/重叠并则保持两段。
   * 而「10月17、18日体检」被两个句子重复提到时，两段相接，会正确并成一段。
   */
  const collapse = (list: DateSchedule[]): DateSchedule[] => {
    if (list.length <= 1) return list;
    const sorted = [...list].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const out: DateSchedule[] = [];
    for (const item of sorted) {
      const last = out[out.length - 1];
      if (last && schedulesOverlap(last, item)) {
        out[out.length - 1] = mergeTwo(last, item);
      } else {
        out.push({ ...item });
      }
    }
    return out;
  };

  // 第三层：主日程。
  //
  // **刻意不再用 parseSchedule(text)**：它是"取所有日期的最早与最晚"，
  // 对这类通知恰好是错的那个——「9月25日截止」与「10月18日采集」合起来
  // 就成了 9-25~10-18 的连续 24 天。
  //
  // 选法：**先认 time 字段指向的那一件**。模型已经把 time 提炼成一个具体日期，
  // 那就是这张卡"最主要的时间"（图像采集通知里它给的是采集日 10-18，
  // 而不是表格截止日 9-25）。认不出来时才退到"报名/截止优先、再取最早的"。
  const deadlineRanges = collapse(deadlineAll);
  const activityRanges = collapse(activityAll);
  const visitRanges = collapse(visitAll);
  const primaryCandidates = byRole.get('primary') ?? [];
  const allCandidates = [...deadlineRanges, ...activityRanges, ...visitRanges, ...primaryCandidates];

  const timeHint = parseSchedule(options.timeText, options);
  // 用"落在区间内"而不是"区间完全相同"来判断：time 文本常常只写一个日子
  // （「10月20日前」），而候选可能是一个区间（10-17~10-20）。
  // 要求完全相等的话这里会永远匹配不上，主日程就选错了。
  const matchesHint = (item: DateSchedule) =>
    timeHint !== undefined && timeHint !== null && item.start <= timeHint.start && item.end >= timeHint.end;

  /**
   * `time` 文本写明的那个日子，是这张卡的**准日子**（模型已经提炼过）。
   *
   * 原文里若找不到对应的句子（官方改了时间、而原文还是旧版），仍必须以它为准：
   * 否则卡片的「时间」与「日程」会对不上——用户看到的是两个互相矛盾的日子。
   * 这类情况真实出现过：「时间」写着 10 月 29 日，日程却显示 10 月 20 日。
   *
   * 但只在**原文里没有任何一条与它重叠**时才补。原文已经写了好几件事时，
   * 硬塞一条 time 的区间会把它们的拆分盖掉（「3月5日开放…3月8日完成」
   * 会被合成一条 4 天，两件事重新粘在一起）。
   */
  const hintIsCovered =
    timeHint !== undefined && timeHint !== null && allCandidates.some((item) => schedulesOverlap(item, timeHint));
  const hintAsSchedule: DateSchedule | null =
    timeHint === null || timeHint === undefined || hintIsCovered
      ? null
      : {
          ...timeHint,
          label: options.timeText?.trim() || timeHint.label,
          role: 'primary',
        };

  const primarySource = allCandidates.find(matchesHint) ?? hintAsSchedule ?? deadlineRanges[0] ??
    [...activityRanges, ...visitRanges, ...primaryCandidates].sort((a, b) => (a.start < b.start ? -1 : 1))[0];
  if (!primarySource) return { schedules: [], primaryFromTimeHint: false };
  /**
   * 主日程**保留它原本判出的角色**，不再统一写成 `primary`。
   *
   * 从前这里强制改成 `primary`，结果是：一张卡有"截止"和"活动"两条时，
   * 主日程那条的标签丢失，日历上两条只长得一样、分不清哪条是哪条。
   * 现在"哪条是主日程"由数组位置表达（固定排第一），角色留给标签用。
   */
  const primaryFromTimeHint = hintAsSchedule !== null && primarySource === hintAsSchedule;
  /**
   * 主日程的时刻以卡片的时间字段为准。
   *
   * 真实缺陷：原文把日期与时刻分成两行（「⏰检查时间：」换行「10月22号」换行
   * 「14：30-17:30」），按小句解析时日期那条拿不到时刻——时间轴上就变成全天，
   * 而卡片上明明白白写着 14:30-17:30。时间字段是模型/用户提炼过的"这件事到底
   * 几点"，原文解析不到时刻时用它补上；用户改了时间字段时（overrideClocks）
   * 则以它为准，覆盖原文里的旧时刻。
   */
  const primary: DateSchedule = primaryFromTimeHint
    ? { ...primarySource }
    : withTimeTextClocks({ ...primarySource }, options.timeText, anchor, options.overrideClocks === true);

  // 第二件及以后：与主日程指向同一段、或被主日程完全覆盖的都不再单列，
  // 否则日历上会出现两条完全重合的条。
  //
  // 没能判出角色的候选（primaryCandidates）也要参与：像「⏰️：10月18日（周日）」
  // 这种只有一个光秃秃日期的句子，角色就是 primary，但它往往是"活动那天"。
  // 早先漏了这一步，图像采集通知的第二件事直接消失了。
  const extras = [...deadlineRanges, ...activityRanges, ...visitRanges, ...primaryCandidates]
    .filter((item) => !(item.start === primary.start && item.end === primary.end))
    .filter((item) => item.end < primary.start || item.start > primary.end)
    // 同一件事被原文重复提到时只留一条（按区间去重，不按角色——
    // 同一天被不同措辞提到，画两条重合的条只是噪声）
    .filter(
      (item, index, all) =>
        all.findIndex((other) => other.start === item.start && other.end === item.end) === index,
    );

  // **主日程固定排第一**，其余按时间先后。
  //
  // 不按时间整体排序：`schedule` 字段就等于 `schedules[0]`，而它要作为卡片上的
  // 「日程」标签与排序依据。按最早排序会让卡片标出次要日期——
  // 图像采集通知的标签会变成 9-25（交表截止），而通知说的是 10-18 采集。
  if (extras.length === 0) return { schedules: [primary], primaryFromTimeHint };
  extras.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { schedules: [primary, ...extras], primaryFromTimeHint };
}

/**
 * 把卡片时间字段里的时刻分配给主日程。
 *
 * 为什么不直接用 parseSchedule(timeText) 的 startTime/endTime：
 * 那个函数不知道这条日程是什么角色。原文写「报名开始时间：9月23日12:30」时
 * 角色是 deadline，12:30 该填 endTime；而时间字段「9月23日12:30」本身没有
 * 「前/截止」字样，单独解析会被当成 startTime，把截止条画成从中午开始。
 * 所以这里以原文判出的角色为准，只借用时间字段里的钟点。
 */
function withTimeTextClocks(
  primary: DateSchedule,
  timeText: string | null | undefined,
  anchor: Date,
  override: boolean,
): DateSchedule {
  const clocks = timeTextClockFields(timeText, primary, anchor);
  if (!clocks) return primary;

  const primaryHasClock = Boolean(primary.startTime) || Boolean(primary.endTime);
  // 创建/回填时原文已经解析出时刻就听原文的；用户改过时间字段时才覆盖
  if (!override && primaryHasClock) return primary;
  if (!clocks.startTime && !clocks.endTime) return primary;

  return { ...primary, startTime: clocks.startTime, endTime: clocks.endTime };
}

/**
 * 从时间字段里取出与主日程同一天的那组时刻，并按原文判出的角色分配起止端。
 * 时间字段里没有可识别时刻时返回 null。
 */
function timeTextClockFields(
  timeText: string | null | undefined,
  primary: DateSchedule,
  anchor: Date,
): { startTime: string | null; endTime: string | null } | null {
  const raw = (timeText ?? '').trim();
  if (raw.length === 0) return null;

  const text = expandAbbreviatedRanges(stripNumSeparator(normalizeDigits(raw)));
  const normalized = normalizeClockText(text);
  if (collectClockTokens(normalized).length === 0) return null;

  const dates = collectExplicitDates(text, anchor);
  const isoOf = (item: RawDate): IsoDate | null => {
    if (item.month < 1 || item.month > 12) return null;
    if (item.day < 1 || item.day > daysInMonth(item.year ?? anchor.getFullYear(), item.month)) return null;
    const year = item.year ?? inferYear(item.month, item.day, anchor).year;
    return toIsoDate(new Date(year, item.month - 1, item.day));
  };
  // 时间字段可能写了多件事（「9月23日报名，9月24日活动」），
  // 取落在主日程区间里的那个日期当锚点，避免把另一件事的时刻挂上来。
  // 有时间字段写了日期、但一个都不落在主日程里，说明它说的是别的事，不借用。
  const target = dates.find((item) => {
    const iso = isoOf(item);
    return iso !== null && iso >= primary.start && iso <= primary.end;
  });
  if (dates.length > 0 && !target) return null;
  const clockAnchor = target?.at ?? 0;

  const hintRole = classifyRole(normalized, clockAnchor);
  const rawRole = primary.role && primary.role !== 'primary' ? primary.role : null;
  // 「截止」优先：原文或时间字段任一方说了截止，就该填 endTime
  const role: ScheduleRole =
    rawRole === 'deadline' || hintRole === 'deadline' ? 'deadline' : rawRole ?? hintRole;

  const fields = clockFieldsFor(normalized, clockAnchor, role);
  return fields.startTime || fields.endTime ? fields : null;
}

/** 改动前的卡片状态：只在"这次保存到底改了什么"的判断里用 */
export interface PreviousScheduleState {
  rawText: string;
  time: string | null;
  schedules: CardSchedule[];
}

export interface ResolveSchedulesOptions extends ParseScheduleOptions {
  /** 卡片 time 字段的文本 */
  timeText?: string | null;
  /** 改动前的时间/原文/排期；创建与回填不传 */
  previous?: PreviousScheduleState;
}

/** trim 后比较，避免"只多了一个空格"被当成改了时间 */
function normalizeTimeText(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/** 同一件事：日期区间与角色都相同（时刻不参与，时刻本身就是这次要更新的东西） */
function sameScheduleSlot(a: DateSchedule | CardSchedule, b: DateSchedule | CardSchedule): boolean {
  return a.start === b.start && a.end === b.end && (a.role ?? 'primary') === (b.role ?? 'primary');
}

/**
 * 算出这张卡在日历上的全部日程——**所有入口都应该走这里**。
 *
 * 与直接调 buildSchedules 的区别只有一条，但很关键：它知道"改动前是什么样"。
 * 用户只改「时间」、不改原文时，原文里的旧日期仍会被解析出来；如果新时间在原文里
 * 找不到对应句子，那条旧主日程就是被新时间取代的，必须从日历上撤掉，
 * 否则旧日期会一直留着——表现为"改动完时间后日历没有同步"。
 *
 * 创建与回填没有 previous，行为与从前一致（原文里的日程全部保留）。
 */
export function resolveSchedules(
  rawText: string | null | undefined,
  options: ResolveSchedulesOptions,
): DateSchedule[] {
  const text = (rawText ?? '').trim();
  const previous = options.previous;
  const timeChanged =
    previous !== undefined && normalizeTimeText(previous.time) !== normalizeTimeText(options.timeText);
  const rawChanged = previous !== undefined && previous.rawText.trim() !== text;

  const built = buildSchedulesWithMeta(text, {
    anchor: options.anchor,
    timeText: options.timeText,
    overrideClocks: timeChanged,
  });
  let schedules = built.schedules;

  if (schedules.length === 0) {
    const single = parseSchedule(options.timeText, { anchor: options.anchor });
    if (!single) return [];
    // 原文里排不出日期时，时间字段就是唯一来源
    schedules = [single];
  }

  if (
    previous === undefined ||
    rawChanged ||
    !timeChanged ||
    !built.primaryFromTimeHint ||
    schedules.length <= 1
  ) {
    return schedules;
  }

  const oldPrimary = previous.schedules[0];
  if (!oldPrimary) return schedules;

  // 只按"日期区间 + 角色"精确匹配被取代的那一条：同一天的另一件事
  // （例如「16:00 前交表」）角色不同，必须保留
  return schedules.filter((item, index) => index === 0 || !sameScheduleSlot(item, oldPrimary));
}

/** 两条日程的区间是否真正重叠（含同一天） */
function schedulesOverlap(a: DateSchedule, b: DateSchedule): boolean {
  return !(a.end < b.start || b.end < a.start);
}

/** 两个 HH:mm 里较早的非空值；字符串比较对补零时刻成立 */
function earlierClock(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a <= b ? a : b;
}

/** 两个 HH:mm 里较晚的非空值；24:00 字符串最大，正好表示当天结束 */
function laterClock(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a >= b ? a : b;
}

/** 合并两条同角色的日程：取并集区间，标注保留文本较完整的那条 */
function mergeTwo(a: DateSchedule, b: DateSchedule): DateSchedule {
  const start = a.start <= b.start ? a.start : b.start;
  const end = a.end >= b.end ? a.end : b.end;
  const label = (a.label.length >= b.label.length ? a.label : b.label) || a.label;
  const role = a.role;
  const startTime = role === 'deadline' ? null : earlierClock(a.startTime, b.startTime);
  const endTime = laterClock(a.endTime, b.endTime);
  return {
    start,
    end,
    dayCount: daysBetween(start, end) + 1,
    label,
    inferredYear: a.inferredYear || b.inferredYear,
    role,
    startTime,
    // 合并后结束早于开始说明两条的时段对不上；按「只有起始」处理，避免负宽度
    endTime: startTime && endTime && endTime < startTime ? null : endTime,
  };
}

/** 相对日期（今天/明天）与星期（周五）的兜底，供单个小句使用 */
function relativeOrWeekday(clause: string, anchor: Date): Date | null {
  for (const relative of RELATIVE_DAYS) {
    if (relative.pattern.test(clause)) {
      const date = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
      date.setDate(date.getDate() + relative.offset);
      return date;
    }
  }

  // 用 match 而不是 exec：这些正则没有 /g，exec 不会带 lastIndex 状态，
  // 但沿用 exec 更容易在日后被加上 /g 时变成"跨调用残留匹配位置"的坑
  const weekdayMatch = clause.match(WEEKDAY_PATTERN);
  const weekday = weekdayMatch?.[1] ? WEEKDAY_INDEX[weekdayMatch[1]] : undefined;
  if (weekday === undefined) return null;

  const isNextWeek = /下周/.test(clause);
  const date = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  const current = date.getDay() === 0 ? 7 : date.getDay();
  let delta = weekday - current;
  if (isNextWeek) delta += 7;
  else if (delta < 0) delta += 7;
  date.setDate(date.getDate() + delta);
  return date;
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

  const text = expandAbbreviatedRanges(stripNumSeparator(normalizeDigits(raw)));
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

  // 时刻只用于时间轴，不写回 role：这里没有拆分日程，
  // 给一个 role 会改变界面上原本不显示的标签。
  const clockAnchor = explicit[0]?.at ?? 0;
  const clockFields = clockFieldsFor(text, clockAnchor, classifyRole(text, clockAnchor));

  return {
    start: startIso,
    end: endIso,
    dayCount: daysBetween(startIso, endIso) + 1,
    label: raw,
    inferredYear,
    ...clockFields,
  };
}
