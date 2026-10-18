import { describe, expect, it } from 'vitest';
import type { CardSchedule } from '@notification-hub/shared';
import {
  barGeometry,
  buildTimeTicks,
  formatDateLabel,
  formatSegment,
  scheduleSegmentOnDay,
} from '../src/lib/day-timeline';

const base: CardSchedule = {
  start: '2026-10-18',
  end: '2026-10-18',
  dayCount: 1,
  label: '',
  inferredYear: false,
};

describe('scheduleSegmentOnDay', () => {
  it('只有起始时刻：画到 24:00', () => {
    expect(scheduleSegmentOnDay({ ...base, startTime: '12:30' }, '2026-10-18')).toEqual({
      startMin: 750,
      endMin: 1440,
      hasTime: true,
      isPoint: false,
    });
  });

  it('只有截止时刻：从 00:00 画到截止', () => {
    expect(scheduleSegmentOnDay({ ...base, endTime: '15:00' }, '2026-10-18')).toEqual({
      startMin: 0,
      endMin: 900,
      hasTime: true,
      isPoint: false,
    });
  });

  it('两端都没有：全天，并标记时刻未识别', () => {
    expect(scheduleSegmentOnDay(base, '2026-10-18')).toEqual({
      startMin: 0,
      endMin: 1440,
      hasTime: false,
      isPoint: false,
    });
  });

  it('两端都有：精确区间', () => {
    expect(
      scheduleSegmentOnDay({ ...base, startTime: '12:30', endTime: '17:30' }, '2026-10-18'),
    ).toEqual({ startMin: 750, endMin: 1050, hasTime: true, isPoint: false });
  });

  it('多日事件：首日从起始时刻开始，中间日全天，末日到截止', () => {
    const multi: CardSchedule = {
      ...base,
      start: '2026-10-17',
      end: '2026-10-19',
      dayCount: 3,
      startTime: '12:30',
      endTime: '15:00',
    };
    expect(scheduleSegmentOnDay(multi, '2026-10-17')).toMatchObject({
      startMin: 750,
      endMin: 1440,
    });
    expect(scheduleSegmentOnDay(multi, '2026-10-18')).toMatchObject({
      startMin: 0,
      endMin: 1440,
      hasTime: true,
    });
    expect(scheduleSegmentOnDay(multi, '2026-10-19')).toMatchObject({
      startMin: 0,
      endMin: 900,
    });
  });

  it('选中日不在区间内返回 null', () => {
    expect(scheduleSegmentOnDay(base, '2026-10-19')).toBeNull();
  });

  it('结束早于开始时按只有起始处理', () => {
    expect(
      scheduleSegmentOnDay({ ...base, startTime: '17:00', endTime: '15:00' }, '2026-10-18'),
    ).toEqual({ startMin: 1020, endMin: 1440, hasTime: true, isPoint: false });
  });

  it('起止相等是点事件', () => {
    expect(
      scheduleSegmentOnDay({ ...base, startTime: '12:30', endTime: '12:30' }, '2026-10-18'),
    ).toEqual({ startMin: 750, endMin: 750, hasTime: true, isPoint: true });
  });

  it('结束 24:00 落在 1440 分钟，不越界到次日', () => {
    expect(scheduleSegmentOnDay({ ...base, endTime: '24:00' }, '2026-10-18')).toEqual({
      startMin: 0,
      endMin: 1440,
      hasTime: true,
      isPoint: false,
    });
  });

  it('非法时刻按缺失处理', () => {
    expect(
      scheduleSegmentOnDay({ ...base, startTime: '25:00', endTime: 'abc' }, '2026-10-18'),
    ).toEqual({ startMin: 0, endMin: 1440, hasTime: false, isPoint: false });
  });
});

describe('时间轴单位与文案', () => {
  it('1 小时 24 个刻度，30 分钟 48 个刻度', () => {
    expect(buildTimeTicks('hour')).toHaveLength(24);
    expect(buildTimeTicks('half-hour')).toHaveLength(48);
    expect(buildTimeTicks('hour')[0]).toEqual({ minutes: 0, label: '00:00' });
    expect(buildTimeTicks('hour').at(-1)).toEqual({ minutes: 1380, label: '23:00' });
    expect(buildTimeTicks('half-hour')[1]).toEqual({ minutes: 30, label: '00:30' });
  });

  it('文案区分全天、时刻未识别与区间', () => {
    expect(formatSegment({ startMin: 0, endMin: 1440, hasTime: false, isPoint: false })).toBe(
      '全天 · 时刻未识别',
    );
    expect(formatSegment({ startMin: 0, endMin: 1440, hasTime: true, isPoint: false })).toBe('全天');
    expect(formatSegment({ startMin: 750, endMin: 1440, hasTime: true, isPoint: false })).toBe(
      '12:30–24:00',
    );
    expect(formatSegment({ startMin: 750, endMin: 750, hasTime: true, isPoint: true })).toBe(
      '12:30',
    );
  });

  it('日期标签保留星期', () => {
    expect(formatDateLabel('2026-10-18')).toBe('10月18日 周日');
  });

  it('12:30–17:30 的条 left=900、width=360', () => {
    const segment = scheduleSegmentOnDay(
      { ...base, startTime: '12:30', endTime: '17:30' },
      '2026-10-18',
    );
    expect(segment).not.toBeNull();
    expect(barGeometry(segment!)).toEqual({ left: 900, width: 360 });
  });
});
