import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addDays,
  buildSchedules,
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

  it('区间端点的年份是明确写法时不算推测', () => {
    const anchor = new Date(2026, 8, 20);
    // 只有两个明确的端点，没有其他没写年份的日期
    const result = schedule('2026年9月28日至2026年9月30日', anchor);

    assert.equal(result?.start, '2026-09-28');
    assert.equal(result?.end, '2026-09-30');
    assert.equal(result?.inferredYear, false, '两端年份都写明了，不该说"年份为推断"');
  });

  it('没写年份的日期成为区间端点时仍算推测', () => {
    // 文中「9月25日」没写年份，而且它成了区间起点，所以要如实标记为推测
    const anchor = new Date(2026, 8, 20);
    const result = schedule('本次运动会定于2026年9月28日至2026年9月30日举行，9月25日前报名。', anchor);

    assert.equal(result?.start, '2026-09-25');
    assert.equal(result?.end, '2026-09-30');
    assert.equal(result?.inferredYear, true);
  });

  it('区间有一端没写年份时仍算推测', () => {
    const anchor = new Date(2026, 8, 20);
    const result = schedule('2026年9月28日至9月30日', anchor);

    assert.equal(result?.start, '2026-09-28');
    assert.equal(result?.end, '2026-09-30');
    assert.equal(result?.inferredYear, true);
  });

  it('没写年份的日期被文中已写明年份的日期带上同一年', () => {
    // 「2026年9月28日…9月30日」这种写法很常见，两端应落在同一年
    const anchor = new Date(2026, 8, 20);
    const result = schedule('活动时间为2026年9月28日到9月30日', anchor);
    assert.equal(result?.start, '2026-09-28');
    assert.equal(result?.end, '2026-09-30');
  });

  it('相对日期与星期推算都算推测', () => {
    assert.equal(schedule('明天截止')?.inferredYear, true);
    assert.equal(schedule('本周五截止')?.inferredYear, true);
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

/**
 * 「号」这个写法来自一次真实事故：
 * 卡片的 time 是「10月22号（第八周周四）14:30-17:30」，而日历把它排在 10-15。
 * 原因是 MONTH_DAY 只匹配「日」不匹配「号」，日期一个字都没读出来，
 * 解析于是退到星期分支、按锚点那一周的周四算，差了整整七天。
 *
 * 这批用例锁的就是"别再退回星期分支"这条界线。
 */
describe('parseSchedule 「号」写法与日期优先于星期', () => {
  it('10月22号（第八周周四）按日期排，不按星期猜', () => {
    // 差七天的那个原始输入：正确结果是 10-22，不是锚点那周的周四 10-09
    const result = schedule('10月22号（第八周周四）14:30-17:30');
    assert.equal(result?.start, '2025-10-22');
    assert.equal(result?.end, '2025-10-22');
    assert.equal(result?.dayCount, 1);
  });

  it('「号」与「日」解析结果一致', () => {
    const withHao = schedule('10月22号14:30-17:30');
    const withRi = schedule('10月22日14:30-17:30');
    assert.ok(withHao, '「号」写法不该解析不出来');
    assert.equal(withHao?.start, withRi?.start);
    assert.equal(withHao?.end, withRi?.end);
  });

  it('年月日全写且用「号」', () => {
    assert.equal(schedule('2026年10月22号')?.start, '2026-10-22');
    assert.equal(schedule('2026年10月22号')?.inferredYear, false);
  });

  it('区间端点用「号」也能形成区间', () => {
    const result = schedule('3月5号开放，3月8号24:00前完成');
    assert.equal(result?.start, '2025-03-05');
    assert.equal(result?.end, '2025-03-08');
    assert.equal(result?.dayCount, 4);
  });

  it('省略月份时沿用文中最近的月份', () => {
    const result = schedule('10月30号、11月2号');
    assert.equal(result?.start, '2025-10-30');
    assert.equal(result?.end, '2025-11-02');
  });

  it('只写「22号」时月份取自锚点，并如实标记为推测', () => {
    // 锚点是 2025-03-05，所以月份取 3
    const result = schedule('22号截止');
    assert.equal(result?.start, '2025-03-22');
    assert.equal(result?.inferredYear, true, '月份是从别处借来的，界面该提示这是推出来的');
  });

  it('文本里写了日期时，解析结果以日期为准、不用星期顶替', () => {
    // 「周四」在这里只是补充说明。锚点是 2025-03-05（周三），
    // 那一周的周四是 03-06——如果日期没被读出来，结果就会是 03-06 而不是 10-22。
    const result = schedule('10月22号（第八周周四）14:30-17:30');
    assert.equal(result?.start, '2025-10-22');
    assert.notEqual(result?.start, '2025-03-06', '不该退回"锚点那一周的周四"');
  });

  it('文本里的日期写法解析失败时，不排期而不是按星期猜', () => {
    // 「13月5日」是像日期但读不出结果的写法：这时必须不排期。
    // 曾经的行为是"没读到日期就退到星期分支"，于是一个坏日期会变成
    // 一个看起来正常、实际错掉的日期——正是这次事故的机制。
    const anchor = new Date(2025, 2, 5, 10, 0, 0); // 周三
    assert.equal(schedule('13月5日（周四）截止', anchor), null);
  });

  it('教学周写法目前排不上日历（未实现，非猜测）', () => {
    // 「第八周周四」没有学期起始日就算不出来，项目里也没有这个配置。
    // 当前它既没有"日/号"日期可读，就落到星期兜底上，结果等于"本周四"——
    // 也就是 03-06 这个**大概率不对但至少不是乱排**的值。
    // 这条用例记录的是现状边界，不是期望值；真要做对需要先有"学期起始日"配置。
    assert.equal(schedule('第八周（周四）')?.start, '2025-03-06');
  });

  it('「第8号文件」这类编号不会被当成日期', () => {
    // 8 号本身像日期，所以这条会排期；记录当前取舍，不是为了证明它完美
    // （真要区分编号与日期需要语义判断，代价远大于收益）
    assert.ok(schedule('第8号文件') !== null);
  });
});

describe('buildSchedules 多日程拆分', () => {
  // 用户的实际诉求：一条通知里"报名截止"与"活动开始"是两个时间，
  // 不能合成一个连续区间——那会把日历画成"活动从截止那天一直持续到活动那天"。
  it('把报名截止与活动拆成两条，而不是合成一个区间', () => {
    const result = buildSchedules(
      '报名开始时间：9月23日12:30开始报名。活动时间：9月24日15:00-16:30在13栋举行。',
      { anchor: ANCHOR, timeText: '9月23日12:30' },
    );

    assert.equal(result.length, 2, `应拆成两条，实际 ${JSON.stringify(result)}`);
    assert.equal(result[0]?.start, '2025-09-23');
    assert.equal(result[1]?.start, '2025-09-24');
    // 关键是**没有**把它们合成 9-23 ~ 9-24 的一个 2 天区间
    assert.notEqual(result[0]?.dayCount, 2);
  });

  it('同一个句子里写成区间的仍然是区间', () => {
    // 「10月17-18日」这种在归一化阶段被展开成完整写法，再合成为一个区间
    const result = buildSchedules('松山湖校区体检时间：10月17-18日。', {
      anchor: ANCHOR,
      timeText: '10月17日',
    });

    assert.equal(result.length, 1, `应是一条区间，实际 ${JSON.stringify(result)}`);
    assert.equal(result[0]?.start, '2025-10-17');
    assert.equal(result[0]?.end, '2025-10-18');
    assert.equal(result[0]?.dayCount, 2);
  });

  it('不同小句里的日期各自成条，不再跨句粘成一个区间', () => {
    // 「3月5日14:00开放」与「3月8日24:00前完成」是两处独立的表述。
    // 从前会把它们合成 3-05~3-08 的一个 4 天区间，日历上看起来像"活动持续四天"。
    // 现在按小句分开——这也正是"报名截止"与"活动"能被拆开的前提。
    const result = buildSchedules('本次选课于3月5日14:00开放，3月8日24:00前完成。', {
      anchor: ANCHOR,
      timeText: '3月5日14:00开放，3月8日24:00前完成',
    });

    assert.equal(result.length, 2, `应是两条，实际 ${JSON.stringify(result)}`);
    // 主日程固定排第一（= time 指向的那条），其余按时间先后
    const starts = result.map((item) => item.start).sort();
    assert.deepEqual(starts, ['2025-03-05', '2025-03-08']);
    // 「3月8日24:00前完成」是截止，应带上截止角色（多日期卡片靠它区分两条）
    const deadline = result.find((item) => item.start === '2025-03-08');
    assert.equal(deadline?.role, 'deadline', `截止那条应判成 deadline，实际 ${deadline?.role}`);
  });

  it('同一件事被重复提到时并成一条', () => {
    // 「10月17-18日体检」与「10月17、18日体检」说的是同一件事
    const result = buildSchedules(
      '松山湖校区体检时间：10月17-18日。10月17、18日（松山湖校区）早上7:00-11:30为体检时间。',
      { anchor: ANCHOR, timeText: '10月17日' },
    );

    assert.equal(result.length, 1, `应并成一条，实际 ${JSON.stringify(result)}`);
    assert.equal(result[0]?.start, '2025-10-17');
    assert.equal(result[0]?.end, '2025-10-18');
  });

  it('截止与考核是两件事时各自成条', () => {
    // 锚点是 2025-03-05，所以不给年份时按 2025 推断；time 提示也写成同年
    const result = buildSchedules(
      '问卷截止时间：10月14日22:00。初定考核时间为：10月24日19:30-22:30。',
      { anchor: ANCHOR, timeText: '10月14日 22:00' },
    );

    assert.equal(result.length, 2, `应拆成两条，实际 ${JSON.stringify(result)}`);
    assert.equal(result[0]?.start, '2025-10-14');
    assert.equal(result[1]?.start, '2025-10-24');
  });

  it('「当天」这类相对词不会在卡片创建日上多出一条安排', () => {
    // 锚点是 2025-03-05；「卫检当天」不是 3 月 5 日
    const result = buildSchedules('请于3月8日16:00前交表。卫检当天请留人在宿舍。', {
      anchor: ANCHOR,
      timeText: '3月8日16:00前',
    });

    assert.ok(
      result.every((item) => item.start !== '2025-03-05'),
      `不该在创建日上排期，实际 ${JSON.stringify(result)}`,
    );
  });

  it('空文本返回空数组', () => {
    assert.deepEqual(buildSchedules('', { anchor: ANCHOR }), []);
    assert.deepEqual(buildSchedules(null, { anchor: ANCHOR }), []);
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
