import type { CardKeywords, CardSchedule, InfoCard } from '@notification-hub/shared';
import { splitIsoDate } from './calendar';

/** 信息卡在界面上的形态：时间与要点列表已归一化，时间戳已格式化为可读中文 */
export interface CardView {
  id: string;
  title: string;
  /** 通知本身的时间，未识别为 null */
  time: string | null;
  /** 来源，未识别为 null */
  source: string | null;
  keyPoints: string[];
  rawText: string;
  /** 日历排期；服务端解析不出日期时为 null，日历上不显示这张卡 */
  schedule: CardSchedule | null;
  /** 生成时的关注点记录，用于在卡片上标出"含你关注的" */
  keywords: CardKeywords;
  provider: InfoCard['provider'];
  /** 入库时间原始 ISO 字符串，供相对时间计算使用 */
  createdAt: string;
  /** 入库时间，格式化为 "2025-03-05 14:32" */
  createdAtLabel: string;
  /** 最近一次编辑时间；从未编辑为 null */
  updatedAt: string | null;
  /** 改动次数；大于 0 时界面显示"已修改"标记 */
  revisionCount: number;
  /** 是否置顶；置顶的卡片始终排在列表最前 */
  pinned: boolean;
}

/**
 * 把服务端返回的任意结构收敛成前端可安全渲染的 CardView。
 *
 * 服务端字段理论上可信，但前端是最后一道防线：字段缺失时宁可显示"未识别"，
 * 也不能让卡片渲染出 undefined 或直接崩掉整个列表。
 */
export function toCardView(input: unknown): CardView | null {
  if (typeof input !== 'object' || input === null) return null;
  const card = input as Partial<InfoCard>;

  if (typeof card.id !== 'string' || card.id.length === 0) return null;

  const keyPoints = Array.isArray(card.keyPoints)
    ? card.keyPoints.filter((point): point is string => typeof point === 'string' && point.trim().length > 0)
    : [];

  return {
    id: card.id,
    title: nonEmptyString(card.title) ?? '未命名通知',
    time: nonEmptyString(card.time),
    source: nonEmptyString(card.source),
    keyPoints,
    rawText: typeof card.rawText === 'string' ? card.rawText : '',
    schedule: toSchedule(card.schedule),
    keywords: toKeywords(card.keywords),
    provider: card.provider === 'deepseek' ? 'deepseek' : 'mock',
    createdAt: typeof card.createdAt === 'string' ? card.createdAt : '',
    createdAtLabel: formatTimestamp(card.createdAt),
    updatedAt: typeof card.updatedAt === 'string' && card.updatedAt.length > 0 ? card.updatedAt : null,
    revisionCount: typeof card.revisionCount === 'number' && card.revisionCount > 0 ? card.revisionCount : 0,
    pinned: card.pinned === true,
  };
}

/**
 * 把排期折成 "3月8日" / "3月8日 - 3月10日" / "2027年3月8日"。
 *
 * 列表默认按事件时间排序，卡片上就必须写出这个日期——
 * 否则用户看到"这张排在前面"却找不到任何排序依据。
 *
 * @param referenceYear 当前年份；日程不在这一年时补上年份。
 *   没有它，今年的 9月23日 和明年的 3月8日 会都写成"9月23日""3月8日"，
 *   排出来的顺序看起来就是乱的。
 */
export function formatScheduleRange(
  schedule: CardSchedule | null,
  referenceYear?: number,
): string | null {
  if (!schedule) return null;
  const start = shortDate(schedule.start, referenceYear);
  if (!start) return null;
  const end = shortDate(schedule.end, referenceYear);
  if (!end || schedule.end === schedule.start) return start;
  return `${start} - ${end}`;
}

function shortDate(value: string, referenceYear?: number): string | null {
  const parts = splitIsoDate(value);
  if (!parts) return null;
  const prefix = referenceYear !== undefined && parts.year !== referenceYear ? `${parts.year}年` : '';
  return `${prefix}${parts.month}月${parts.day}日`;
}

/** 日程的归一化：起始日期不合法就当作没有排期，避免把坏数据铺进日历 */
function toSchedule(input: unknown): CardSchedule | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  const start = nonEmptyString(record.start);
  const end = nonEmptyString(record.end);
  if (!start || !end) return null;
  return {
    start,
    end,
    dayCount: typeof record.dayCount === 'number' && record.dayCount > 0 ? record.dayCount : 1,
    label: typeof record.label === 'string' ? record.label : '',
    inferredYear: record.inferredYear === true,
  };
}

/** 关键词记录的归一化：缺失或损坏都退回空记录（老卡片没有这个字段） */
function toKeywords(input: unknown): CardKeywords {
  const record = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const toList = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  return {
    priority: toList(record.priority),
    hit: toList(record.hit),
    missed: toList(record.missed),
  };
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 格式化为本地时区的 "YYYY-MM-DD HH:mm"；解析失败就原样回显 */
export function formatTimestamp(value: unknown): string {
  if (typeof value !== 'string') return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const pad = (num: number) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 把时间戳转成短相对时间（"刚刚" / "3 分钟前" / "2 天前"），超过 7 天回退成完整日期 */
export function formatRelative(value: string | null | undefined, now: number = Date.now()): string {
  if (typeof value !== 'string' || value.length === 0) return '时间未知';
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return value;

  const diffSeconds = Math.floor((now - timestamp) / 1000);
  if (diffSeconds < 60) return '刚刚';
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)} 分钟前`;
  if (diffSeconds < 86_400) return `${Math.floor(diffSeconds / 3600)} 小时前`;
  if (diffSeconds < 7 * 86_400) return `${Math.floor(diffSeconds / 86_400)} 天前`;
  return formatTimestamp(value);
}
