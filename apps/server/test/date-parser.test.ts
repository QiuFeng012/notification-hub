import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addDays,
  daysBetween,
  daysInMonth,
  parseIsoDate,
  parseSchedule,
  toIsoDate,
} from '../src/calendar/date-parser.js';

/** 固定锚点，避免测试结果跟着运行时间漂移 */
const ANCHOR = new Date(2025, 2, 5, 10, 0, 0); // 2025-03-05 本地时间

function schedule(timeText: string | null | undefined, anchor: Date = ANCHOR) {
  return parseSchedule(timeText, { anchor });
}

describe('日期工具', () => {
  it('toIsoDate 用本地日期，不会因时区偏移挪一天', () => {
    // 本地 00:30 的日期，用 toISOString 会变成前一天
    assert.equal(toIsoDate(new Date(2025, 0, 1, 0, 30)), '2025-01-01');
    assert.equal(toIsoDate(new Date(2025, 11, 31, 23, 30)), '2025-12-31');
  });

  it('parseIsoDate 解析合法串，非法串返回 null', () => {
    assert.deepEqual(parseIsoDate('2025-03-08'), { year: 2025, month: 3, day: 8 });
    assert.equal(parseIsoDate('2025-3-8'), null);
    assert.equal(parseIsoDate('not-a-date'), null);
    assert.equal(parseIsoDate(''), null);
  });

  it('addDays 跨月跨年正确', () => {
    assert.equal(addDays('2025-03-05', 3), '2025-03-08');
    assert.equal(addDays('2025-02-28', 1), '2025-03-01');
    assert.equal(addDays('2024-02-28', 1), '2024-02-29', '2024 是闰年');
    assert.equal(addDays('2025-12-31', 1), '2026-01-01');
    assert.equal(addDays('2025-03-05', -1), '2025-03-04');
  });

  it('daysBetween 按日历日计算', () => {
    assert.equal(daysBetween('2025-03-05', '2025-03-08'), 3);
    assert.equal(daysBetween('2025-03-08', '2025-03-05'), -3);
    assert.equal(daysBetween('2025-03-05', '2025-03-05'), 0);
    assert.equal(daysBetween('2025-02-28', '2025-03-01'), 1);
  });

  it('daysInMonth 处理闰年与非法月份', () => {
    assert.equal(daysInMonth(2025, 2), 28);
    assert.equal(daysInMonth(2024, 2), 29);
    assert.equal(daysInMonth(2025, 4), 30);
    assert.equal(daysInMonth(2025, 12), 31);
    assert.equal(daysInMonth(2025, 13), 0);
    assert.equal(daysInMonth(2025, 0), 0);
  });
});

describe('parseSchedule 单日', () => {
  it('解析「3月8日24:00前」', () => {
    const result = schedule('3月8日24:00前');
    assert.equal(result?.start, '2025-03-08');
    assert.equal(result?.end, '2025-03-08');
    assert.equal(result?.dayCount, 1);
  });

  it('解析完整年月日', () => {
    const result = schedule('2025-03-08');
    assert.equal(result?.start, '2025-03-08');
    assert.equal(result?.inferredYear, false, '写了年份就不算推测');
  });

  it('解析 2025年3月8日 形式', () => {
    assert.equal(schedule('2025年3月8日')?.start, '2025-03-08');
  });

  it('解析 3/8 形式', () => {
    assert.equal(schedule('3/8 截止')?.start, '2025-03-08');
  });

  it('时刻不会被误判成日期', () => {
    // 14:00 里的 14 不是月份
    const result = schedule('3月5日14:00开放');
    assert.equal(result?.start, '2025-03-05');
    assert.equal(result?.dayCount, 1);
  });

  it('中文数字日期也能解析', () => {
    assert.equal(schedule('三月八日前提交')?.start, '2025-03-08');
    assert.equal(schedule('十二月三十一日截止')?.start, '2025-12-31');
  });

  it('全角数字也能解析', () => {
    assert.equal(schedule('３月８日')?.start, '2025-03-08');
  });
});

describe('parseSchedule 多日范围', () => {
  it('两个日期取最早与最晚，形成区间', () => {
    const result = schedule('3月5日至3月8日');
    assert.equal(result?.start, '2025-03-05');
    assert.equal(result?.end, '2025-03-08');
    assert.equal(result?.dayCount, 4);
  });

  it('「开放到截止」这种常见通知形成区间', () => {
    const result = schedule('3月5日14:00开放，3月8日24:00前完成');
    assert.equal(result?.start, '2025-03-05');
    assert.equal(result?.end, '2025-03-08');
    assert.equal(result?.dayCount, 4);
  });

  it('三个日期取首尾', () => {
    const result = schedule('3月5日、3月7日、3月10日');
    assert.equal(result?.start, '2025-03-05');
    assert.equal(result?.end, '2025-03-10');
    assert.equal(result?.dayCount, 6);
  });

  it('跨月区间正确', () => {
    const result = schedule('3月30日至4月2日');
    assert.equal(result?.start, '2025-03-30');
    assert.equal(result?.end, '2025-04-02');
    assert.equal(result?.dayCount, 4);
  });

  it('跨年区间正确', () => {
    const result = schedule('2025年12月30日至2026年1月2日');
    assert.equal(result?.start, '2025-12-30');
    assert.equal(result?.end, '2026-01-02');
    assert.equal(result?.dayCount, 4);
  });
});

describe('parseSchedule 相对日期', () => {
  it('今天 / 明天 / 后天 / 大后天', () => {
    assert.equal(schedule('今天截止')?.start, '2025-03-05');
    assert.equal(schedule('明天上午停水')?.start, '2025-03-06');
    assert.equal(schedule('后天截止')?.start, '2025-03-07');
    assert.equal(schedule('大后天截止')?.start, '2025-03-08');
  });

  it('「当天」也算今天', () => {
    assert.equal(schedule('当天有效')?.start, '2025-03-05');
  });

  it('相对日期与显式日期并存时以显式为准', () => {
    const result = schedule('3月10日（明天）截止');
    assert.equal(result?.start, '2025-03-10');
    assert.equal(result?.dayCount, 1);
  });
});

describe('parseSchedule 星期', () => {
  // 锚点是 2025-03-05，星期三
  it('本周五解析为本周内的那个周五', () => {
    assert.equal(schedule('本周五截止')?.start, '2025-03-07');
  });

  it('下周一解析为下一周', () => {
    assert.equal(schedule('下周一开会')?.start, '2025-03-10');
  });

  it('本周内已过去的星期被视为下周，而不是排到过去', () => {
    // 锚点是周三，本周一已经过去，应排到 3-10（下周一）
    assert.equal(schedule('周一截止')?.start, '2025-03-10');
  });

  it('星期写法支持「星期」与数字', () => {
    assert.equal(schedule('星期五截止')?.start, '2025-03-07');
    assert.equal(schedule('周五截止')?.start, '2025-03-07');
    assert.equal(schedule('周日截止')?.start, '2025-03-09');
    assert.equal(schedule('下周日截止')?.start, '2025-03-16');
  });
});

describe('parseSchedule 年份推断', () => {
  it('月日比锚点早半年以上时推断为明年', () => {
    // 锚点 2025-03-05，文本 1月10日 —— 早了两个多月，不算超半年
    assert.equal(schedule('1月10日')?.start, '2025-01-10');
    // 锚点 2025-03-05，文本 1月10日 若是 12 月的锚点则应推断为明年
    const decemberAnchor = new Date(2025, 11, 20);
    assert.equal(schedule('1月10日', decemberAnchor)?.start, '2026-01-10');
  });

  it('没写年份时标记 inferredYear 为 true', () => {
    assert.equal(schedule('3月8日')?.inferredYear, true);
    assert.equal(schedule('2025年3月8日')?.inferredYear, false);
  });

  it('无效月日被丢弃而不是算出错误日期', () => {
    // 2月30日不存在
    assert.equal(schedule('2月30日截止'), null);
    // 13 月不存在
    assert.equal(schedule('13月5日截止'), null);
  });
});

describe('parseSchedule 解析不出来的情况', () => {
  it('空文本返回 null', () => {
    assert.equal(schedule(null), null);
    assert.equal(schedule(undefined), null);
    assert.equal(schedule(''), null);
    assert.equal(schedule('   '), null);
  });

  it('没有日期的文本返回 null，而不是猜一个', () => {
    assert.equal(schedule('未识别'), null);
    assert.equal(schedule('待定'), null);
    assert.equal(schedule('尽快'), null);
    assert.equal(schedule('长期有效'), null);
  });

  it('只有时刻没有日期时返回 null', () => {
    assert.equal(schedule('14:00'), null);
  });

  it('只写年份不构成日期', () => {
    assert.equal(schedule('2025年'), null);
  });
});

describe('parseSchedule 返回的 label', () => {
  it('保留原文，便于界面解释为什么排在这天', () => {
    const result = schedule('3月8日24:00前');
    assert.equal(result?.label, '3月8日24:00前');
  });

  it('label 是裁剪过的原文本', () => {
    assert.equal(schedule('  3月8日  ')?.label, '3月8日');
  });
});
