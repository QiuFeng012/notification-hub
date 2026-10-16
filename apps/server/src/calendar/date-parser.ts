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

import type { ScheduleRole } from '@notification-hub/shared';

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
const DEADLINE_KEYWORDS = ['截止', '之前', '报名', '提交', '填写', '申请', '反馈'];
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

/** 某个小句里最靠后的关键词位置；没有则返回 -1 */
function lastKeywordIndex(clause: string, keywords: string[]): number {
  let best = -1;
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
  if (candidates.length === 0) return 'primary';
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0]?.role ?? 'primary';
}

/** 把一组已解析的日期合成一条日程（取最早与最晚） */
function toSchedule(
  dates: Date[],
  yearInferred: boolean[],
  label: string,
  role: ScheduleRole,
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
  options: ParseScheduleOptions & {
    /**
     * 卡片 time 字段的文本，用来指出"哪一件是主日程"。
     *
     * 模型已经把 time 提炼成一个具体日期，那通常就是这张卡最主要的时间
     * （图像采集通知给的是采集日，而不是表格截止日）。没有它时退到
     * "报名/截止优先、再取最早的"。
     */
    timeText?: string | null;
  },
): DateSchedule[] {
  const raw = (text ?? '').trim();
  if (raw.length === 0) return [];

  const anchor = options.anchor;

  // 第一层：逐句解析，每句一条候选（同句里的多个日期是"这件事的两端"，合到一条）
  const merged: DateSchedule[] = [];
  for (const clause of splitClauses(raw)) {
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
    if (dates.length === 0) continue;

    // 角色取句内离第一个日期最近的那类关键词
    const first = collectExplicitDates(normalized, anchor)[0];
    const role = classifyRole(normalized, first?.at ?? 0);
    merged.push(toSchedule(dates, inferred, clause, role));
  }
  if (merged.length === 0) return [];

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

  const primarySource =
    allCandidates.find(matchesHint) ??
    deadlineRanges[0] ??
    [...activityRanges, ...visitRanges, ...primaryCandidates].sort((a, b) => (a.start < b.start ? -1 : 1))[0];
  if (!primarySource) return [];
  const primary: DateSchedule = { ...primarySource, role: 'primary' };

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

  if (extras.length === 0) return [primary];
  const result = [primary, ...extras];
  result.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return result;
}

/** 两条日程的区间是否真正重叠（含同一天） */
function schedulesOverlap(a: DateSchedule, b: DateSchedule): boolean {
  return !(a.end < b.start || b.end < a.start);
}

/** 合并两条同角色的日程：取并集区间，标注保留文本较完整的那条 */
function mergeTwo(a: DateSchedule, b: DateSchedule): DateSchedule {
  const start = a.start <= b.start ? a.start : b.start;
  const end = a.end >= b.end ? a.end : b.end;
  const label = (a.label.length >= b.label.length ? a.label : b.label) || a.label;
  return {
    start,
    end,
    dayCount: daysBetween(start, end) + 1,
    label,
    inferredYear: a.inferredYear || b.inferredYear,
    role: a.role,
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

  return {
    start: startIso,
    end: endIso,
    dayCount: daysBetween(startIso, endIso) + 1,
    label: raw,
    inferredYear,
  };
}
