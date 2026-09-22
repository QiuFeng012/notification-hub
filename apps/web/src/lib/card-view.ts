import type { InfoCard } from '@notification-hub/shared';

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
  provider: InfoCard['provider'];
  /** 入库时间原始 ISO 字符串，供相对时间计算使用 */
  createdAt: string;
  /** 入库时间，格式化为 "2025-03-05 14:32" */
  createdAtLabel: string;
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
    provider: card.provider === 'deepseek' ? 'deepseek' : 'mock',
    createdAt: typeof card.createdAt === 'string' ? card.createdAt : '',
    createdAtLabel: formatTimestamp(card.createdAt),
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
