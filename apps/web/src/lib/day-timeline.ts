import type { CardSchedule } from '@notification-hub/shared';
import { splitIsoDate } from './calendar';

/** 一天有多少分钟；24:00 折算成 1440 */
export const MINUTES_PER_DAY = 1440;
/** 时间轴横向比例：1 小时 72px */
export const HOUR_WIDTH = 72;
/** 00:00–24:00 的完整宽度 */
export const PLOT_WIDTH = (MINUTES_PER_DAY / 60) * HOUR_WIDTH;
/** 与月视图表头一致：周一在最左、周日在最右 */
export const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

/** 时间轴刻度单位；只影响刻度与网格，不影响条的位置 */
export type TimelineUnit = 'hour' | 'half-hour';

/** 横轴刻度区高度；y 轴刻度的起点必须与它一致 */
export const AXIS_HEIGHT = 28;
/** 一个事件行的高度；y 轴刻度按它计算行中心 */
export const ROW_HEIGHT = 48;

/** 一条日程在选中日上的裁剪结果 */
export interface DaySegment {
  /** 当天开始分钟，0–1440 */
  startMin: number;
  /** 当天结束分钟，0–1440 */
  endMin: number;
  /** 日程是否至少有一端合法时刻；false 时界面显示"全天 · 时刻未识别" */
  hasTime: boolean;
  /** 起止相等：点事件，界面上给最小可见宽度 */
  isPoint: boolean;
}

/** 把 HH:mm 解析成分钟；非法返回 null */
export function parseClockMinutes(
  value: string | null | undefined,
  options: { allowEndOfDay?: boolean } = {},
): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (minute < 0 || minute > 59) return null;
  if (hour === 24 && minute === 0) return options.allowEndOfDay ? MINUTES_PER_DAY : null;
  if (hour < 0 || hour > 23) return null;
  return hour * 60 + minute;
}

function formatClock(minutes: number): string {
  if (minutes >= MINUTES_PER_DAY) return '24:00';
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * 把日程裁剪成选中日上的一段。
 *
 * 统一公式：首日从 startTime（缺省 00:00）开始，末日到 endTime（缺省 24:00），
 * 中间日整天。只有一端时刻时，另一端落在当天边界——这正是"只有起始画到 24:00、
 * 只有截止从 00:00 画起"的来源。
 */
export function scheduleSegmentOnDay(schedule: CardSchedule, date: string): DaySegment | null {
  if (date < schedule.start || date > schedule.end) return null;

  const startTime = parseClockMinutes(schedule.startTime);
  const endTime = parseClockMinutes(schedule.endTime, { allowEndOfDay: true });
  const hasTime = startTime !== null || endTime !== null;

  const startMin = date === schedule.start ? (startTime ?? 0) : 0;
  let endMin = date === schedule.end ? (endTime ?? MINUTES_PER_DAY) : MINUTES_PER_DAY;

  // 数据坏成"结束早于开始"时，按只有起始处理；不把负宽度画出来
  if (endMin < startMin) endMin = MINUTES_PER_DAY;

  return {
    startMin,
    endMin,
    hasTime,
    isPoint: endMin === startMin,
  };
}

/** 条在 1728px 画布上的 left / width */
export function barGeometry(segment: DaySegment): { left: number; width: number } {
  return {
    left: (segment.startMin / 60) * HOUR_WIDTH,
    width: Math.max(0, ((segment.endMin - segment.startMin) / 60) * HOUR_WIDTH),
  };
}

/** 时间轴刻度；23:00 / 23:30 是最后一个刻度，24:00 由轴右端单独标出 */
export function buildTimeTicks(unit: TimelineUnit): Array<{ minutes: number; label: string }> {
  const step = unit === 'hour' ? 60 : 30;
  const ticks: Array<{ minutes: number; label: string }> = [];
  for (let minutes = 0; minutes < MINUTES_PER_DAY; minutes += step) {
    ticks.push({ minutes, label: formatClock(minutes) });
  }
  return ticks;
}

/** 条上/条外的文案：全天、时刻未识别、精确区间或点事件 */
export function formatSegment(segment: DaySegment): string {
  if (!segment.hasTime) return '全天 · 时刻未识别';
  if (segment.startMin === 0 && segment.endMin === MINUTES_PER_DAY) return '全天';
  if (segment.isPoint) return formatClock(segment.startMin);
  return `${formatClock(segment.startMin)}–${formatClock(segment.endMin)}`;
}

/** 日期标题：10月18日 周日；非法日期原样返回 */
export function formatDateLabel(date: string): string {
  const parts = splitIsoDate(date);
  if (!parts) return date;
  const weekday = new Date(parts.year, parts.month - 1, parts.day).getDay();
  const label = WEEKDAY_LABELS[weekday === 0 ? 6 : weekday - 1] ?? '';
  return `${parts.month}月${parts.day}日 周${label}`;
}
