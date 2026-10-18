# 日历日期时间轴视图（Day Timeline）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 点日历日期后打开一块只画第四象限的 00:00–24:00 时间轴，每个日程一行、按起止时刻定位；时刻缺失时诚实显示全天。

**Architecture:** 先在共享类型与确定性解析器里补可选的 `startTime/endTime`，用 `SCHEDULE_VERSION` 6→7 回填旧卡；再用纯函数把日程裁剪成当天一段，由新 `DayTimeline` 组件渲染；最后把时间轴嵌进现有 `calendar-detail` 外壳，保留下方原有详情与编辑入口。

**Tech Stack:** TypeScript、Fastify（Node ≥22.5）、React 19 + Vite、node:test、vitest + testing-library、pnpm workspace、SQLite（node:sqlite）。

**Spec:** [docs/superpowers/specs/2026-10-18-day-timeline-design.md](../specs/2026-10-18-day-timeline-design.md)

## Global Constraints

- `CardSchedule.startTime` / `endTime` 为可选 `string | null`，格式 `HH:mm`；`24:00` 只允许出现在 `endTime`。
- 时刻是本地时间，不做 UTC 转换；不引入日期/时间库，全部用分钟数计算。
- `SCHEDULE_VERSION` 从 6 升到 7；回填只改 `schedule` / `schedules` / `schedule_version`，不动 `updated_at`、`revision_count`，不写改动历史。
- 时间轴固定 `HOUR_WIDTH = 72px`、`PLOT_WIDTH = 1728px`；行高 48px，条高 26px。
- 单位切换只改刻度与网格：`1 小时` 24 个刻度，`30 分钟` 48 个刻度；条的 `left/width` 不变。
- 保留 `calendar-detail` 外层类名与 `data-testid`，以及下方详情列表；原有修改 / 改颜色 / 查看原文 / 改动历史不得回退。
- 界面文案逐字使用：`1 小时`、`30 分钟`、`收起`、`这天没有安排。`、`全天 · 时刻未识别`、`时间轴 0 点到 24 点`。
- 每个任务独立 commit，使用 Conventional Commits（中文描述）；不自动 push。
- 交付前必须跑 `pnpm verify`、`pnpm smoke`、`pnpm verify:ui`，全部通过才算完成。

## Review Focus

1. **同句出现多组时刻（办公时间 + 截止）**：只取离日期最近的一组，绝不能把 `9:00-17:00` 的办公时间挂到另一件事上。→ Task 1 的「同句里的办公时间不会被挂到另一件事上」与「多组时刻只取最近一组」用例。
2. **多日事件的中间日**：应铺满 00:00–24:00，而不是从 `startTime` 才开始。→ Task 3 的「首日 / 中间日 / 末日」用例。
3. **24:00 与 00:00 边界**：不能走 `new Date(...)` 造成 `24:00` 变次日或非法日期；条必须止于右边缘。→ Task 1 的 `24:00` 用例与 Task 3 的 1440 分钟用例。
4. **没有时刻的旧卡**：仍要出现在时间轴上，显示全天并标「时刻未识别」，不能消失或崩溃。→ Task 3 的「都没有时刻」与 Task 5 的旧数据组件用例。
5. **23:30 的短条与条外标签**：条要可见、可点，标签不能把坐标轴或相邻内容挤出容器。→ Task 4 的短条用例与 Task 5 的点击高亮用例。

---

## Preflight: 分支、备份与基线

**Files:** 无代码改动。

- [ ] **Step 1: 从 main 开分支**

Run:
```bash
git switch main
git switch -c feat/day-timeline
```

- [ ] **Step 2: 备份真实数据库（回填会改写 `schedules`）**

Run:
```bash
Copy-Item data/cards.db data/cards.db.bak-20261018 -Force
```

- [ ] **Step 3: 跑基线**

Run:
```bash
pnpm verify
```
Expected: 服务端 296 通过 / 1 跳过，前端 336 通过，退出码 0。

---

### Task 1: 服务端解析日程起止时刻

**Files:**
- Modify: `packages/shared/src/calendar.ts`
- Modify: `apps/server/src/calendar/date-parser.ts`
- Test: `apps/server/test/date-parser.test.ts`

**Interfaces:**
- Produces: `DateSchedule.startTime?: string | null`、`DateSchedule.endTime?: string | null`；
  `parseSchedule()` 与 `buildSchedules()` 的返回值都带这两个字段。
- Produces: 内部函数 `clockFieldsFor(text: string, anchorIndex: number, role: ScheduleRole): { startTime: string | null; endTime: string | null }`。
- Consumes: 现有 `parseChineseNumber()`、`collectExplicitDates()`、`classifyRole()`、`toSchedule()`、`mergeTwo()`。

- [ ] **Step 1: 写失败的测试**

在 `apps/server/test/date-parser.test.ts` 末尾追加：

```ts
describe('日程时刻', () => {
  it('只有起始时刻：15:00 开始的活动没有结束时刻', () => {
    const s = schedule('3月5日15:00开放');
    assert.equal(s?.startTime, '15:00');
    assert.equal(s?.endTime, null);
  });

  it('区间同时给出起止时刻', () => {
    const s = schedule('3月5日14:30-17:30');
    assert.equal(s?.startTime, '14:30');
    assert.equal(s?.endTime, '17:30');
  });

  it('只有截止时刻：16:00 前完成', () => {
    const s = schedule('3月5日16：00前');
    assert.equal(s?.startTime, null);
    assert.equal(s?.endTime, '16:00');
  });

  it('24:00 只作为结束时刻', () => {
    const deadline = schedule('3月5日24:00前');
    assert.equal(deadline?.startTime, null);
    assert.equal(deadline?.endTime, '24:00');

    const bare = schedule('3月5日24:00');
    assert.equal(bare?.startTime, null);
    assert.equal(bare?.endTime, '24:00');
  });

  it('下午 / 中文数字 / 全角时刻', () => {
    assert.equal(schedule('3月5日下午三点半')?.startTime, '15:30');
    assert.equal(schedule('3月5日晚上7点')?.startTime, '19:00');
    assert.equal(schedule('3月5日１４：３０开放')?.startTime, '14:30');
  });

  it('时刻在日期之前时取日期前最近的一组', () => {
    const s = schedule('14:30开始，3月5日活动');
    assert.equal(s?.startTime, '14:30');
  });

  it('同句多组时刻只取日期之后最近的一组', () => {
    const s = schedule('3月5日9:00-10:00及14:00-15:00');
    assert.equal(s?.startTime, '09:00');
    assert.equal(s?.endTime, '10:00');
  });

  it('同句里的办公时间不会被挂到另一件事上', () => {
    // 按逗号切成两句后，前一句没有日期，不该把 9:00-17:00 带到后一句的截止上
    const list = buildSchedules('办公时间9:00-17:00，3月5日16:00前提交报名表', {
      anchor: ANCHOR,
    });
    assert.equal(list.length, 1);
    assert.equal(list[0]?.startTime, null);
    assert.equal(list[0]?.endTime, '16:00');
  });

  it('非法时刻被丢弃，日期仍保留', () => {
    for (const text of ['3月5日25:00', '3月5日12:60', '3月5日9:5']) {
      const s = schedule(text);
      assert.equal(s?.startTime, null, text);
      assert.equal(s?.endTime, null, text);
      assert.equal(s?.start, '2025-03-05', text);
    }
  });

  it('结束早于开始时只保留起始时刻', () => {
    const s = schedule('3月5日14:30-14:15');
    assert.equal(s?.startTime, '14:30');
    assert.equal(s?.endTime, null);
  });

  it('两个不同角色的日程各自拿到自己的时刻', () => {
    const list = buildSchedules('9月23日12:30报名截止，9月24日15:00活动举行', {
      anchor: ANCHOR,
    });
    const deadline = list.find((item) => item.role === 'deadline');
    const activity = list.find((item) => item.role === 'activity');
    assert.equal(deadline?.startTime, null);
    assert.equal(deadline?.endTime, '12:30');
    assert.equal(activity?.startTime, '15:00');
    assert.equal(activity?.endTime, null);
  });

  it('同角色重叠日程合并时保留最早开始与最晚结束', () => {
    const list = buildSchedules('3月5日14:30-15:30体检，3月5日15:00-16:30体检', {
      anchor: ANCHOR,
    });
    assert.equal(list.length, 1);
    assert.equal(list[0]?.startTime, '14:30');
    assert.equal(list[0]?.endTime, '16:30');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter @notification-hub/server test
```
Expected: 新增用例失败，失败信息是 `expected undefined to equal '15:00'` 或 `expected undefined to equal null`。

- [ ] **Step 3: 加共享字段**

在 `packages/shared/src/calendar.ts` 的 `CardSchedule` 里、`inferredYear` 之后加：

```ts
/**
 * 起始时刻 HH:mm；文本里没有可靠时刻时为 null。
 * 只允许 00:00–23:59；24:00 只允许出现在 endTime。
 */
startTime?: string | null;
/** 截止时刻 HH:mm；24:00 表示当天结束 */
endTime?: string | null;
```

- [ ] **Step 4: 在 `date-parser.ts` 里实现时刻解析**

在 `DateSchedule` 上加同样两个字段。然后按以下决定实现：

1. `normalizeClockText(text)`：全角数字转半角、`：` 转 `:`。
2. `collectClockTokens(text)`：收集三类 token，返回 `{ minutes, index, endIndex }[]`，按 `index` 排序并去重：
   - `/(上午|下午|中午|晚上|凌晨|早上|傍晚|夜里|夜间)?\s*(\d{1,2})\s*:\s*(\d{2})/g`
   - `/(上午|下午|中午|晚上|凌晨|早上|傍晚|夜里|夜间)?\s*(\d{1,2})\s*[点时](?:\s*(\d{1,2})\s*分?|\s*半)?/g`
   - 中文数字版本：小时/分钟捕获组使用 `[零一二三四五六七八九十]{1,3}`，再用现有 `parseChineseNumber()` 转换。
3. 分钟换算：`hour * 60 + minute`；`minute` 必须 0–59；`hour` 必须 0–23，只有 `24:00` 合法并折算 1440。
4. 时段修正：
   - `下午 / 晚上 / 傍晚 / 夜里 / 夜间`：`hour < 12` 时 +12；
   - `中午`：`hour` 为 1–2 时 +12，其余不变；
   - `凌晨 / 早上 / 上午`：`hour === 12` 时改为 0；
   - 没有时段词不修正。
5. `groupClockTokens(tokens, text)`：相邻两个 token 之间去掉空白后只含 `[-~—－至到]` 时归为同一组；
   否则各自成组。
6. `clockFieldsFor(text, anchorIndex, role)`：
   - 取 `index >= anchorIndex` 的第一组；没有则取结束位置在 `anchorIndex` 之前的最后一组；
   - 组内第一个 token 是开始，最后一个 token 是结束；
   - `role === 'deadline'`：只返回 `endTime`（组内最后一个）；`startTime` 为 null；
   - 否则组内至少两个且结束大于开始：两端都返回；只有单个 token：只返回 `startTime`；
   - 任意 token 为 1440：只能作为 `endTime`；
   - 结束小于开始：丢弃结束；
   - 没有任何 token：两端都是 null。
7. `toSchedule` 增加参数：

```ts
function toSchedule(
  dates: Date[],
  yearInferred: boolean[],
  label: string,
  role: ScheduleRole,
  clockText: string = label,
  clockAnchor: number = 0,
): DateSchedule
```
   在 `buildSchedules` 调用处传 `normalized` 与 `first?.at ?? 0`，`label` 仍保留原始 `clause`。
8. `parseSchedule` 用 `const first = explicit[0]; const role = classifyRole(text, first?.at ?? 0);`
   计算时刻并展开进返回值；**不要把 role 写进返回值**，避免改变现有标签行为。
9. `mergeTwo` 合并时刻：
   - `startTime` 取较早的非空值；`endTime` 取较晚的非空值；
   - `role === 'deadline'` 时强制 `startTime = null`；
   - 合并后 `endTime < startTime` 时丢弃 `endTime`；相等保留为点事件。

- [ ] **Step 5: 运行测试确认通过**

Run:
```bash
pnpm --filter @notification-hub/server test
```
Expected: 全部通过，包含新增的「日程时刻」用例。

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/calendar.ts apps/server/src/calendar/date-parser.ts apps/server/test/date-parser.test.ts
git commit -m "feat(server): 解析日程的起止时刻"
```

---

### Task 2: 回填旧卡并升级解析版本

**Files:**
- Modify: `apps/server/src/db/sqlite-repository.ts:220-235`
- Test: `apps/server/test/card-repository.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `startTime/endTime`。
- Produces: `SCHEDULE_VERSION = 7`；旧卡启动时自动回填时刻。

- [ ] **Step 1: 写失败的测试**

在 `apps/server/test/card-repository.test.ts` 中：

1. 把「解析器修好后会重算旧卡片按老规则算出的排期」里的版本断言从 6 改成 7。
2. 在同一条用例里补：

```ts
assert.equal(repo.get('old')?.schedule?.startTime, '14:30');
assert.equal(repo.get('old')?.schedule?.endTime, '17:30');
```

3. 新增一条「写入与读回保留起止时刻」：

```ts
it('写入与读回的日程保留起止时刻', () => {
  const repo = createSqliteCardRepository(tempDbPath());
  try {
    const schedule = {
      start: '2026-10-18',
      end: '2026-10-18',
      dayCount: 1,
      label: '10月18日14:30-17:30',
      inferredYear: false,
      startTime: '14:30',
      endTime: '17:30',
    };
    const card = makeCard({ schedule, schedules: [schedule] });
    repo.insert(card);
    assert.deepEqual(repo.get(card.id)?.schedules, [schedule]);
  } finally {
    repo.close();
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter @notification-hub/server test
```
Expected: 版本断言失败（实际 6，期望 7），且旧卡的时刻为 undefined。

- [ ] **Step 3: 升级版本号**

把 `apps/server/src/db/sqlite-repository.ts` 的常量改为：

```ts
const SCHEDULE_VERSION = 7;
```

在版本注释列表末尾补一行：

```text
 * 7：解析日程的起止时刻（startTime / endTime），供日期时间轴按小时定位
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter @notification-hub/server test
```
Expected: 全部通过；旧卡回填后 `startTime` / `endTime` 正确。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/sqlite-repository.ts apps/server/test/card-repository.test.ts
git commit -m "feat(server): 回填日程起止时刻并升级解析版本"
```

---

### Task 3: 前端时间轴纯函数与数据归一化

**Files:**
- Create: `apps/web/src/lib/day-timeline.ts`
- Test: `apps/web/test/day-timeline.test.ts`
- Modify: `apps/web/src/lib/card-view.ts`
- Test: `apps/web/test/card-view.test.ts`

**Interfaces:**
- Produces:
  - `MINUTES_PER_DAY = 1440`、`HOUR_WIDTH = 72`、`PLOT_WIDTH = 1728`。
  - `type TimelineUnit = 'hour' | 'half-hour'`。
  - `parseClockMinutes(value: string | null | undefined, options?: { allowEndOfDay?: boolean }): number | null`。
  - `interface DaySegment { startMin: number; endMin: number; hasTime: boolean; isPoint: boolean }`。
  - `scheduleSegmentOnDay(schedule: CardSchedule, date: string): DaySegment | null`。
  - `buildTimeTicks(unit: TimelineUnit): Array<{ minutes: number; label: string }>`。
  - `barGeometry(segment: DaySegment): { left: number; width: number }`。
  - `formatSegment(segment: DaySegment): string`。
  - `formatDateLabel(date: string): string`、`WEEKDAY_LABELS: string[]`。
- Consumes: Task 1 的 `CardSchedule.startTime/endTime`；现有 `splitIsoDate`。

- [ ] **Step 1: 写 `day-timeline.test.ts` 的失败用例**

```ts
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
    expect(
      scheduleSegmentOnDay({ ...base, endTime: '24:00' }, '2026-10-18'),
    ).toEqual({ startMin: 0, endMin: 1440, hasTime: true, isPoint: false });
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
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
pnpm --filter @notification-hub/web exec vitest run test/day-timeline.test.ts
```
Expected: 模块不存在或函数未定义。

- [ ] **Step 3: 实现 `day-timeline.ts`**

- `parseClockMinutes`：正则 `/^(\d{1,2}):(\d{2})$/`；分钟 0–59；小时 0–23；
  `24:00` 只在 `allowEndOfDay` 时返回 1440；其余返回 null。
- `scheduleSegmentOnDay`：按规格 7.1 的公式；`hasTime` 看日程是否至少有一端合法时刻；
  结束小于开始时把结束当作 24:00；起止相等 `isPoint = true`。
- `barGeometry`：`left = startMin / 60 * HOUR_WIDTH`，`width = (endMin - startMin) / 60 * HOUR_WIDTH`。
- `buildTimeTicks`：步长 60 或 30，从 0 到 `< 1440`；标签用 `HH:mm`。
- `formatSegment`：`!hasTime` → `全天 · 时刻未识别`；`0–1440` → `全天`；
  `isPoint` → 单个时刻；否则 `start–end`。
- `formatDateLabel`：复用 `splitIsoDate` 与 `WEEKDAY_LABELS`，输出 `10月18日 周日`，非法日期原样返回。
- `WEEKDAY_LABELS = ['一','二','三','四','五','六','日']`。

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
pnpm --filter @notification-hub/web exec vitest run test/day-timeline.test.ts
```
Expected: 全部通过。

- [ ] **Step 5: 写 `card-view` 的失败用例**

在 `apps/web/test/card-view.test.ts` 的 `describe('toCardView')` 里加：

```ts
it('保留合法的起止时刻，丢弃非法值', () => {
  const schedule = {
    start: '2026-10-18',
    end: '2026-10-18',
    dayCount: 1,
    label: '',
    inferredYear: false,
  };
  const card = {
    ...VALID_CARD,
    schedule: { ...schedule, startTime: '09:05', endTime: '24:00' },
    schedules: [{ ...schedule, startTime: '09:05', endTime: '24:00' }],
  };
  expect(toCardView(card)?.schedule?.startTime).toBe('09:05');
  expect(toCardView(card)?.schedule?.endTime).toBe('24:00');

  const invalid = {
    ...VALID_CARD,
    schedule: { ...schedule, startTime: '24:00', endTime: '25:00' },
    schedules: [{ ...schedule, startTime: '24:00', endTime: '25:00' }],
  };
  expect(toCardView(invalid)?.schedule?.startTime).toBeUndefined();
  expect(toCardView(invalid)?.schedule?.endTime).toBeUndefined();
});
```

- [ ] **Step 6: 运行确认失败，然后实现 `toCardView` 归一化**

Run:
```bash
pnpm --filter @notification-hub/web exec vitest run test/card-view.test.ts
```
Expected: 新用例失败，`startTime` 为 undefined。

在 `apps/web/src/lib/card-view.ts` 的 `toSchedule` 里加一个 `normalizeClock(value, allowEndOfDay)`：

- 只接受 `/^(\d{1,2}):(\d{2})$/`，分钟 0–59，小时 0–23；`24:00` 仅在允许结束时刻时通过；
- `startTime` 不允许 `24:00`；
- `endTime` 与 `startTime` 都有且 `endTime < startTime`（字符串比较即可）时丢掉 `endTime`；
- 相等保留（点事件）；
- 非法或缺失就不往返回对象里放这个字段。

- [ ] **Step 7: 运行确认通过**

Run:
```bash
pnpm --filter @notification-hub/web exec vitest run test/day-timeline.test.ts test/card-view.test.ts
```
Expected: 全部通过。

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/day-timeline.ts apps/web/test/day-timeline.test.ts apps/web/src/lib/card-view.ts apps/web/test/card-view.test.ts
git commit -m "feat(web): 新增日期时间轴排版纯函数"
```

---

### Task 4: DayTimeline 组件与样式

**Files:**
- Create: `apps/web/src/components/DayTimeline.tsx`
- Create: `apps/web/src/lib/schedule-labels.ts`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/test/DayTimeline.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `scheduleSegmentOnDay`、`barGeometry`、`buildTimeTicks`、`formatSegment`、`formatDateLabel`、`PLOT_WIDTH`、`HOUR_WIDTH`。
- Produces:

```ts
export interface TimelineEntry {
  card: CardView;
  schedule: CardSchedule;
  scheduleIndex: number;
  key: string;
}

export interface DayTimelineProps {
  date: string;
  entries: TimelineEntry[];
  highlight: HighlightStyle;
  activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: () => void;
}
```

- Produces: `SCHEDULE_ROLE_LABELS: Record<ScheduleRole, string>`，值沿用现有
  `截止 / 活动 / 到场 / 主要`。

- [ ] **Step 1: 写组件失败用例**

新建 `apps/web/test/DayTimeline.test.tsx`：

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_HIGHLIGHT_STYLE, type CardSchedule } from '@notification-hub/shared';
import { DayTimeline, type TimelineEntry } from '../src/components/DayTimeline';
import type { CardView } from '../src/lib/card-view';

function entry(overrides: Partial<CardSchedule> = {}, key = 'card#0'): TimelineEntry {
  const schedule: CardSchedule = {
    start: '2026-10-18',
    end: '2026-10-18',
    dayCount: 1,
    label: '',
    inferredYear: false,
    ...overrides,
  };
  const card = {
    id: 'card',
    title: '测试活动',
    schedule,
    schedules: [schedule],
  } as unknown as CardView;
  return { card, schedule, scheduleIndex: 0, key };
}

function renderTimeline(entries: TimelineEntry[], activeKey: string | null = null) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <DayTimeline
      date="2026-10-18"
      entries={entries}
      highlight={DEFAULT_HIGHLIGHT_STYLE}
      activeKey={activeKey}
      onSelect={onSelect}
      onClose={onClose}
    />,
  );
  return { onSelect, onClose };
}

describe('DayTimeline', () => {
  it('左上角是选中日期，坐标轴有 00:00 与 24:00', () => {
    renderTimeline([entry({ startTime: '12:30', endTime: '17:30' })]);
    expect(screen.getByTestId('day-timeline')).toHaveTextContent('10月18日 周日');
    const axis = screen.getByTestId('timeline-axis');
    expect(axis).toHaveTextContent('00:00');
    expect(axis).toHaveTextContent('24:00');
  });

  it('事件条位置与宽度按 72px/小时计算', () => {
    renderTimeline([entry({ startTime: '12:30', endTime: '17:30' })]);
    const bar = screen.getByTestId('timeline-bar');
    expect(bar).toHaveAttribute('data-start-min', '750');
    expect(bar).toHaveAttribute('data-end-min', '1050');
    expect(bar.style.left).toBe('900px');
    expect(bar.style.width).toBe('360px');
  });

  it('一个日程一行', () => {
    renderTimeline([
      entry({ startTime: '09:00', endTime: '10:00' }, 'a#0'),
      entry({ startTime: '14:00', endTime: '15:00' }, 'b#0'),
    ]);
    expect(screen.getAllByTestId('timeline-row')).toHaveLength(2);
    expect(screen.getAllByTestId('timeline-bar')).toHaveLength(2);
  });

  it('单位切换只改刻度数量，不改变条位置', async () => {
    renderTimeline([entry({ startTime: '12:30', endTime: '17:30' })]);
    expect(screen.getAllByTestId('timeline-tick')).toHaveLength(24);
    const before = screen.getByTestId('timeline-bar').style.left;

    await userEvent.click(screen.getByRole('button', { name: '30 分钟' }));
    expect(screen.getAllByTestId('timeline-tick')).toHaveLength(48);
    expect(screen.getByTestId('timeline-bar').style.left).toBe(before);
  });

  it('没有时刻时显示全天并标时刻未识别', () => {
    renderTimeline([entry()]);
    const bar = screen.getByTestId('timeline-bar');
    expect(bar).toHaveAttribute('data-has-time', 'false');
    expect(bar).toHaveTextContent('全天 · 时刻未识别');
  });

  it('短条把标题放到条外', () => {
    renderTimeline([entry({ startTime: '23:30', endTime: '23:45' })]);
    expect(screen.getByTestId('timeline-bar-outside')).toHaveTextContent('测试活动');
  });

  it('点击条回传 key', async () => {
    const { onSelect } = renderTimeline([entry({ startTime: '12:30' })]);
    await userEvent.click(screen.getByTestId('timeline-bar'));
    expect(onSelect).toHaveBeenCalledWith('card#0');
  });

  it('选中态给条加 active 类', () => {
    renderTimeline([entry({ startTime: '12:30' })], 'card#0');
    expect(screen.getByTestId('timeline-bar')).toHaveClass('day-timeline__bar--active');
  });

  it('点「收起」回传 onClose', async () => {
    const { onClose } = renderTimeline([]);
    await userEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('空日期仍渲染坐标轴与空态', () => {
    renderTimeline([]);
    expect(screen.getByTestId('timeline-axis')).toBeInTheDocument();
    expect(screen.getByText('这天没有安排。')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run:
```bash
pnpm --filter @notification-hub/web exec vitest run test/DayTimeline.test.tsx
```
Expected: 组件模块不存在。

- [ ] **Step 3: 实现 `schedule-labels.ts`**

```ts
import type { ScheduleRole } from '@notification-hub/shared';

export const SCHEDULE_ROLE_LABELS: Record<ScheduleRole, string> = {
  deadline: '截止',
  activity: '活动',
  visit: '到场',
  primary: '主要',
};
```

- [ ] **Step 4: 实现 `DayTimeline.tsx`**

结构要求：

- 外层 `div.day-timeline[data-testid="day-timeline"]`。
- 表头：`h3` 日期；`role="group"` 的单位按钮组（`aria-pressed`）；「收起」按钮。
- 横向滚动容器 `.day-timeline__scroll`；内部 `.day-timeline__canvas` 宽 `PLOT_WIDTH`。
- `.day-timeline__axis[data-testid="timeline-axis"]`：
  - 每个 `buildTimeTicks(unit)` 生成一个 `.day-timeline__tick[data-testid="timeline-tick"]`，
    `style.left = minutes / 60 * HOUR_WIDTH`，文案 `label`。
  - 右端单独一个 `24:00` 标签（`data-testid="timeline-axis-end"`），不参与刻度计数。
  - 隐藏文字「时间轴 0 点到 24 点」。
- 行：每个 entry 先 `scheduleSegmentOnDay`，为 null 的过滤掉；按 `startMin`、
  `card.title`、`scheduleIndex` 排序。每行 `.day-timeline__row[data-testid="timeline-row"]`。
- 条：
  - `button.day-timeline__bar[data-testid="timeline-bar"]`，`style.left/width` 用 `barGeometry`，
    `data-entry-key`、`data-row`、`data-start-min`、`data-end-min`、`data-has-time`。
  - 背景 `--span-color` 用 `resolveCardColor(card, highlight)`，墨色用
    `readableTextColor(color, 'var(--span-ink-dark)', 'var(--span-ink-light)')`。
  - `aria-label` 用 `${title} ${formatSegment(segment)}`；`title` 同样。
  - 宽条（`width >= 110`）在条内放角色标签（仅当同一张卡有多条日程）、标题、时刻；
    短条把同样的信息放到 `.day-timeline__bar-outside[data-testid="timeline-bar-outside"]`，
    默认在条右侧，右侧超出 24:00 时改左侧。
  - `isPoint` 或 `endMin - startMin === 0` 时视觉最小宽度 10px；`data-*` 保持真实值。
- 选中：`activeKey === entry.key` 时加 `day-timeline__bar--active`。
- 空态：`entries.length === 0` 时在轴下方显示「这天没有安排。」。
- 滚动：`useEffect` 在 `date` 或第一行变化时把 `scrollLeft` 设为
  `max(0, firstStartMin - 60) / 60 * HOUR_WIDTH`；没有行则 `7 * 60` 对应位置。
  单位切换不重新滚动。
- 单位状态：`useState<TimelineUnit>('hour')`；`date` 变化时重置为 `'hour'`。

- [ ] **Step 5: 加样式**

在 `apps/web/src/styles.css` 新增「日期时间轴」段，至少包含：

- `.day-timeline`：边框、圆角、背景 `var(--bg-elevated)`。
- `.day-timeline__head`：flex 两端对齐；日期在左，控件在右。
- `.day-timeline__scroll`：`overflow-x: auto`，`overflow-y: hidden`。
- `.day-timeline__canvas`：`width: 1728px`，`position: relative`。
- `.day-timeline__axis`：高 28px，`position: sticky; top: 0`，背景不透明，
  `background-image` 用 1px 竖线 + `background-size: 72px 100%`；30 分钟模式用 36px。
- `.day-timeline__tick`：绝对定位、`transform: translateX(-50%)`、10.5–11px、
  `color: var(--text-dim)`；第一个刻度不偏移；`24:00` 用 `right: 0`。
- `.day-timeline__row`：高 48px，`border-top: 1px solid var(--border)`，`position: relative`。
- `.day-timeline__bar`：绝对定位、`top: 11px`、`height: 26px`、`border-radius: 13px`、
  `min-width: 10px`、`overflow: hidden`、`display: flex`、`align-items: center`、
  `gap: 6px`、`padding: 0 9px`、`border: none`、`cursor: pointer`、
  `background: var(--span-color)`、`color: var(--span-ink)`。
- `.day-timeline__bar--active`：`outline: 2px solid var(--accent); outline-offset: 2px`。
- `.day-timeline__bar-outside`：绝对定位、`top: 15px`、`font-size: 11.5px`、
  `white-space: nowrap`、`max-width: 220px`、省略号、`pointer-events: none`、
  `color: var(--text-body)`。
- `.day-timeline__empty`：`padding: 16px`、`color: var(--text-dim)`。
- 窄窗口只横向滚动，不压缩条宽。

- [ ] **Step 6: 运行确认通过**

Run:
```bash
pnpm --filter @notification-hub/web exec vitest run test/DayTimeline.test.tsx
```
Expected: 10 条用例全部通过。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/DayTimeline.tsx apps/web/src/lib/schedule-labels.ts apps/web/src/styles.css apps/web/test/DayTimeline.test.tsx
git commit -m "feat(web): 新增日期时间轴组件与坐标样式"
```

---

### Task 5: 接入日历视图并保留原有详情

**Files:**
- Modify: `apps/web/src/components/CalendarView.tsx`
- Test: `apps/web/test/CalendarView.test.tsx`

**Interfaces:**
- Consumes: Task 4 的 `DayTimeline`、`TimelineEntry`、`SCHEDULE_ROLE_LABELS`；
  Task 3 的 `formatDateLabel`、`WEEKDAY_LABELS`。
- Produces: 点日期后 `calendar-detail` 内出现 `day-timeline`，下方详情结构不变。

- [ ] **Step 1: 写失败的组件用例**

在 `apps/web/test/CalendarView.test.tsx` 的「点日期看当天安排」里加：

```tsx
it('点日期打开日期时间轴，左上角是选中日期', async () => {
  await openCalendar([
    makeCard({
      title: '时间轴活动',
      schedule: { ...schedule('2025-03-06'), startTime: '12:30', endTime: '17:30' },
    }),
  ]);
  await screen.findByText('2025 年 3 月');

  await userEvent.click(document.querySelector('[data-date="2025-03-06"]') as HTMLElement);

  const timeline = await screen.findByTestId('day-timeline');
  expect(timeline).toHaveTextContent('3月6日 周四');
  const bar = within(timeline).getByTestId('timeline-bar');
  expect(bar).toHaveAttribute('data-start-min', '750');
  expect(bar).toHaveAttribute('data-end-min', '1050');
});

it('时间轴里点条会高亮下方对应详情', async () => {
  await openCalendar([
    makeCard({
      title: '时间轴活动',
      schedule: { ...schedule('2025-03-06'), startTime: '12:30', endTime: '17:30' },
    }),
  ]);
  await screen.findByText('2025 年 3 月');
  await userEvent.click(document.querySelector('[data-date="2025-03-06"]') as HTMLElement);

  await userEvent.click(await screen.findByTestId('timeline-bar'));
  expect(screen.getByTestId('calendar-detail-item')).toHaveClass('calendar__detail-item--active');
});

it('没有时刻的旧卡在时间轴上显示全天', async () => {
  await openCalendar([makeCard({ title: '旧卡', schedule: schedule('2025-03-06') })]);
  await screen.findByText('2025 年 3 月');
  await userEvent.click(document.querySelector('[data-date="2025-03-06"]') as HTMLElement);

  expect(await screen.findByTestId('timeline-bar')).toHaveTextContent('全天 · 时刻未识别');
});
```

- [ ] **Step 2: 运行确认失败**

Run:
```bash
pnpm --filter @notification-hub/web exec vitest run test/CalendarView.test.tsx
```
Expected: 找不到 `day-timeline` / `timeline-bar`。

- [ ] **Step 3: 改 `CalendarView.tsx`**

1. 删掉本地的 `WEEKDAY_LABELS`、`SCHEDULE_ROLE_LABELS`、`formatDateLabel`；
   改为从 `../lib/day-timeline` 导入 `formatDateLabel`、`WEEKDAY_LABELS`，
   从 `../lib/schedule-labels` 导入 `SCHEDULE_ROLE_LABELS`。
   同时删掉不再使用的 `ScheduleRole` 类型导入，避免 `noUnusedLocals` 报错。
2. `selectedDate` 分支外层保留：
   `className="calendar__detail calendar__detail--timeline"` 与
   `data-testid="calendar-detail"`；里面先渲染：

```tsx
<DayTimeline
  date={selectedDate}
  entries={selectedEntries}
  highlight={styleForRender}
  activeKey={activeEntryKey}
  onSelect={setActiveEntryKey}
  onClose={() => setSelectedDate(null)}
/>
```
3. 删除原来的 `h3.calendar__detail-title`（日期已在时间轴左上角）。
4. 下方详情列表只在 `selectedEntries.length > 0` 时渲染；空态由 `DayTimeline` 负责。
   原有 `<ul>...</ul>`、编辑表单、颜色面板、历史、原文逻辑保持不动。
5. 日期圆与区间点击逻辑不变；区间点击仍把 `selectedDate` 设为起始日，
   并把 `activeEntryKey` 设为该条。

- [ ] **Step 4: 运行现有与新增用例**

Run:
```bash
pnpm --filter @notification-hub/web exec vitest run test/CalendarView.test.tsx
```
Expected: 现有 53 条 + 新增 3 条全部通过。若旧用例因删掉日期 `h3` 而找不到文本，
确认日期文本是否已由 `DayTimeline` 表头提供；不要为了过测试把重复标题加回来。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/CalendarView.tsx apps/web/test/CalendarView.test.tsx
git commit -m "feat(web): 日历点日期打开日期时间轴"
```

---

### Task 6: 真实浏览器验证、文档与并入 main

**Files:**
- Modify: `scripts/ui-delete-check.mts`
- Modify: `scripts/smoke.mts`
- Modify: `README.md`
- No production code changes unless verification finds a defect.

**Interfaces:**
- Consumes: Task 5 的 `day-timeline` / `timeline-bar` / `timeline-tick` 选择器。
- Produces: `pnpm verify:ui` 覆盖时间轴几何；README 有「日期时间轴」章节；main 合并完成。

- [ ] **Step 1: 让界面验证脚本产生一条当天带时刻的卡片**

把第 3 步提交的原文改成同时包含当天活动与截止：

```ts
'【界面验证】今天14:30-16:00参加界面验证活动，3月8日24:00前提交报名表。'
```

这样卡片会在「今天」有一条 14:30–16:00 的活动，供时间轴几何检查使用。

- [ ] **Step 2: 加 `measureDayTimeline` 检查函数**

在 `measureTrackEndpoints` 之后加：

```ts
async function measureDayTimeline(cdp: {
  evaluate<T>(expression: string): Promise<T>;
}): Promise<string[]> {
  return cdp.evaluate<string[]>(`
    (() => {
      const timeline = document.querySelector('[data-testid="day-timeline"]');
      if (!timeline) return ['没有打开日期时间轴'];
      const axis = timeline.querySelector('[data-testid="timeline-axis"]');
      const bars = [...timeline.querySelectorAll('[data-testid="timeline-bar"]')];
      if (!axis) return ['时间轴缺少坐标轴'];
      if (bars.length === 0) return ['时间轴没有事件条'];

      const problems = [];
      const axisBox = axis.getBoundingClientRect();
      if (axisBox.width < 1720) {
        problems.push('坐标轴宽度 ' + axisBox.width.toFixed(1) + 'px，应接近 1728px');
      }
      const bar = bars[0];
      const barBox = bar.getBoundingClientRect();
      const start = Number(bar.dataset.startMin);
      const end = Number(bar.dataset.endMin);
      const expectedLeft = axisBox.left + start / 60 * 72;
      const expectedWidth = Math.max(10, (end - start) / 60 * 72);
      if (Math.abs(barBox.left - expectedLeft) > 2) {
        problems.push('条左端偏离 ' + (barBox.left - expectedLeft).toFixed(1) + 'px');
      }
      if (Math.abs(barBox.width - expectedWidth) > 2) {
        problems.push('条宽度 ' + barBox.width.toFixed(1) + 'px，应为 ' + expectedWidth.toFixed(1) + 'px');
      }
      return problems;
    })()
  `);
}
```

- [ ] **Step 3: 在卡片生成之后插入 4b 段**

位置：第 4 步确认新卡在列表里之后、第 5 步置顶之前。

```ts
console.log('4b. 日期时间轴：点日期、条位置与单位切换');
check('切到「日历视图」', await cdp.evaluate<boolean>(`
  (() => {
    const tab = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('日历视图'));
    if (!tab) return false;
    tab.click();
    return true;
  })()
`));
await sleep(800);

const opened = await cdp.evaluate<boolean>(`
  (() => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    const circle = document.querySelector('[data-date="' + today + '"]');
    if (!circle) return false;
    circle.click();
    return true;
  })()
`);
check('能点开今天的日期', opened);
await sleep(600);
check('今天的时间轴已渲染', await cdp.evaluate<boolean>(`Boolean(document.querySelector('[data-testid="day-timeline"]'))`));

const timelineProblems = await measureDayTimeline(cdp);
check('时间轴的轴宽与条位置正确', timelineProblems.length === 0, timelineProblems.join('；'));

const ticksBefore = await cdp.evaluate<number>(
  `document.querySelectorAll('[data-testid="timeline-tick"]').length`,
);
check('1 小时单位有 24 个刻度', ticksBefore === 24, String(ticksBefore));
check('能点「30 分钟」', await cdp.evaluate<boolean>(`
  (() => {
    const button = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === '30 分钟');
    if (!button) return false;
    button.click();
    return true;
  })()
`));
await sleep(200);
const ticksAfter = await cdp.evaluate<number>(
  `document.querySelectorAll('[data-testid="timeline-tick"]').length`,
);
check('30 分钟单位有 48 个刻度', ticksAfter === 48, String(ticksAfter));

check('点时间轴上的条能高亮详情', await cdp.evaluate<boolean>(`
  (async () => {
    const bar = document.querySelector('[data-testid="timeline-bar"]');
    if (!bar) return false;
    bar.click();
    return Boolean(await window.__waitFor(() => document.querySelector('.calendar__detail-item--active')));
  })()
`));

// 回到列表，继续后面的置顶 / 删除流程
check('切回「卡片列表」', await cdp.evaluate<boolean>(`
  (() => {
    const tab = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('卡片列表'));
    if (!tab) return false;
    tab.click();
    return true;
  })()
`));
await sleep(600);
```

- [ ] **Step 4: 更新 README**

在「日历视图」章节末尾新增 `### 日期时间轴`，至少写清：

- 点日期打开；左上角日期，下面是 00:00–24:00 的第四象限时间轴。
- 一个日程一行；只有起始时刻画到 24:00，只有截止时刻从 00:00 画到截止，
  两端都没有显示「全天 · 时刻未识别」。
- `1 小时 / 30 分钟` 只切换刻度与网格，不改变条的位置。
- 时刻由服务端从原文的小句解析，解析不到不猜；旧卡由 `SCHEDULE_VERSION=7` 回填。
- 下方保留当天详情与编辑入口。

- [ ] **Step 4b: 冒烟测试断言真实 API 返回时刻**

在 `scripts/smoke.mts` 第 2 步创建卡片后加：

```ts
check(
  '排期带上截止时刻（真实 API 序列化）',
  created.schedule?.endTime === '24:00',
  JSON.stringify(created.schedule),
);
```

这条断言覆盖「类型加了字段、但响应里没带出来」这类只有真链路才看得见的问题。

- [ ] **Step 5: 跑完整验证链路**

Run:
```bash
pnpm verify
pnpm build
pnpm start
```
Expected: `pnpm verify` 全绿；`pnpm build` 成功；服务在 `http://127.0.0.1:5178` 起来。

另开一个终端：

```bash
pnpm smoke
pnpm verify:ui
```
Expected: 两个脚本都输出全部通过；`verify:ui` 新增的「时间轴的轴宽与条位置正确」等断言 PASS。

结束后停止后台服务（`scripts/stop-server.ps1` 或结束本次启动的后台任务）。

- [ ] **Step 6: 真实浏览器亲眼看一次**

在运行中的服务上打开 `http://127.0.0.1:5178`，点一张有日期的卡片所在的日期，
确认：

- 日期在左上角，轴从 00:00 到 24:00；
- 条的位置与时间相符，短条标题在条外；
- 切换 `30 分钟` 后刻度变密、条不动；
- 点条后下方详情高亮；
- 空日期显示轴与「这天没有安排。」

- [ ] **Step 7: Commit 验证脚本与文档**

```bash
git add scripts/ui-delete-check.mts scripts/smoke.mts
git commit -m "test(scripts): 界面验证覆盖日期时间轴几何"
git add README.md
git commit -m "docs: 补充日期时间轴视图说明"
```

- [ ] **Step 8: 并入 main**

```bash
git switch main
git merge --no-ff feat/day-timeline -m "feat: 新增日历日期时间轴视图"
pnpm verify
```

Expected: 合并成功，`main` 上 `pnpm verify` 全绿。不要自动 `git push`；
如需推送，另行执行 `git push origin main`。

---

## Self-Review

**Spec coverage:**

| 规格章节 | 覆盖任务 |
| --- | --- |
| 5 数据契约 | Task 1 / Task 3 |
| 6 时刻解析 | Task 1 |
| 7.1 裁剪公式 | Task 3 |
| 7.2 行与几何 | Task 3 / Task 4 |
| 7.3 轴与空态 | Task 4 |
| 8 UI 结构与组件边界 | Task 4 / Task 5 |
| 9 交互 | Task 4 / Task 5 / Task 6 |
| 10 边界与错误处理 | Task 1 / Task 3 / Task 4 |
| 11 测试策略 | 全部任务 |
| 12 回填、发布与回滚 | Task 2 / Task 6 |
| 13 验收标准 | Task 6 |
| 14 风险 | Review Focus + 各任务用例 |

**Type consistency:** `TimelineEntry` / `DayTimelineProps` 在 Task 4 定义，Task 5 直接复用；
`DaySegment` 在 Task 3 定义，Task 4 的 `barGeometry` / `formatSegment` 使用同一类型；
`SCHEDULE_ROLE_LABELS` 由 Task 4 定义、Task 5 导入；`formatDateLabel` / `WEEKDAY_LABELS`
由 Task 3 定义、Task 5 导入。

**Proportion:** 计划只固定接口、算法决策与测试断言；组件与 CSS 的具体实现留给实现者。

## Execution Handoff

计划已保存到 `docs/superpowers/plans/2026-10-18-day-timeline.md`。
请审阅后选择执行方式：Subagent-driven（每个任务独立实现与评审）或 Native（我在本会话内逐任务实现，
最后统一评审）。本计划任务之间共享类型与解析器接口，推荐 Native，减少跨代理的接口漂移。
