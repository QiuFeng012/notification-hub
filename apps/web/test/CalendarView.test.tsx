import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HIGHLIGHT_STYLE,
  type CardSchedule,
  type HighlightStyle,
  type SettingsView,
} from '@notification-hub/shared';
import App from '../src/App';
import type { CardApi, SettingsApi } from '../src/lib/api';
import type { CardView } from '../src/lib/card-view';

const TODAY = '2025-03-05';

function dayCountOf(start: string, end: string): number {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000) + 1;
}

function schedule(start: string, end: string = start): CardSchedule {
  return { start, end, dayCount: dayCountOf(start, end), label: `${start} 起`, inferredYear: true };
}

function makeCard(overrides: Partial<CardView> = {}): CardView {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    title: '选课开放通知',
    time: '3月5日至3月8日',
    source: '教务处',
    keyPoints: ['要点一'],
    rawText: '原文',
    schedule: schedule('2025-03-05', '2025-03-08'),
    keywords: { priority: [], hit: [], missed: [] },
    provider: 'deepseek',
    createdAt: '2025-03-05T06:32:00.000Z',
    createdAtLabel: '2025-03-05 14:32',
    ...overrides,
  };
}

function makeSettings(overrides: Partial<SettingsView> = {}): SettingsView {
  return {
    configured: true,
    apiKeyMask: 'sk-test…test',
    source: 'user',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    highlight: {
      ...DEFAULT_HIGHLIGHT_STYLE,
      multiDayPalette: [...DEFAULT_HIGHLIGHT_STYLE.multiDayPalette],
      perCard: {},
    } as HighlightStyle,
    ...overrides,
  };
}

function makeApis(cards: CardView[], settings: SettingsView = makeSettings()) {
  const cardApi: CardApi = {
    listCards: vi.fn(async () => cards),
    createCard: vi.fn(async () => makeCard()),
    deleteCard: vi.fn(async () => undefined),
  };
  const settingsApi: SettingsApi = {
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (patch) => ({
      settings: {
        ...settings,
        highlight: {
          ...settings.highlight,
          ...(patch.highlight ?? {}),
          perCard: { ...settings.highlight.perCard, ...(patch.highlight?.perCard ?? {}) },
        },
      },
      warning: null,
    })),
    clearSettings: vi.fn(async () => settings),
  };
  return { cardApi, settingsApi };
}

async function openCalendar(cards: CardView[], settings?: SettingsView) {
  const { cardApi, settingsApi } = makeApis(cards, settings);
  render(<App api={cardApi} settingsApi={settingsApi} today={TODAY} />);
  await userEvent.click(await screen.findByRole('tab', { name: '日历视图' }));
  return { cardApi, settingsApi };
}

/** 找到包含指定日期圆的那一周 */
function weekOf(date: string): HTMLElement {
  const circle = document.querySelector(`[data-date="${date}"]`);
  const week = circle?.closest('[data-testid="calendar-week"]');
  if (!week) throw new Error(`找不到 ${date} 所在的周`);
  return week as HTMLElement;
}

/**
 * 取某条区间在某一周里的那一段。
 *
 * 不能按日期倒查容器：跨周区间在每一周里都是独立的 DOM 节点，
 * 而它显示的文字与所在周无关，容易取错。所以直接按卡片 id 取出所有段，
 * 再按落点日期判断属于哪一周。
 */
function spanSegment(cardId: string, weekDate: string): HTMLElement | null {
  const startOfWeek = Number(weekOf(weekDate).querySelector('[data-date]')?.getAttribute('data-day') ?? '0');
  void startOfWeek;
  return (
    ([...document.querySelectorAll(`[data-card-id="${cardId}"]`)].find((element) =>
      element.closest('[data-testid="calendar-week"]') === weekOf(weekDate),
    ) as HTMLElement | undefined) ?? null
  );
}

/** 某周里的所有区间 */
function spansInWeek(weekDate: string): HTMLElement[] {
  return [...weekOf(weekDate).querySelectorAll('[data-testid="calendar-span"]')] as HTMLElement[];
}

describe('视图切换', () => {
  it('默认显示卡片列表', async () => {
    const { cardApi, settingsApi } = makeApis([makeCard()]);
    render(<App api={cardApi} settingsApi={settingsApi} today={TODAY} />);

    expect(await screen.findByTestId('info-card')).toBeInTheDocument();
    expect(screen.queryByTestId('calendar-week')).not.toBeInTheDocument();
  });

  it('切到日历后按月分周渲染，再切回恢复列表', async () => {
    await openCalendar([makeCard()]);

    expect(screen.getAllByTestId('calendar-week').length).toBeGreaterThan(0);
    expect(screen.getByText('2025 年 3 月')).toBeInTheDocument();
    expect(screen.queryByTestId('info-card')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: '卡片列表' }));
    expect(await screen.findByTestId('info-card')).toBeInTheDocument();
  });

  it('顶部徽标在日历视图显示有日期的条数', async () => {
    await openCalendar([
      makeCard({ id: 'a', schedule: schedule('2025-03-05') }),
      makeCard({ id: 'b', schedule: null }),
    ]);

    expect(await screen.findByText('1 条有日期')).toBeInTheDocument();
  });
});

describe('圆形日期与周排版', () => {
  it('每个日期是一个圆', async () => {
    await openCalendar([makeCard()]);
    await screen.findByText('2025 年 3 月');

    const days = screen.getAllByTestId('calendar-day');
    // 2025 年 3 月共 31 天
    expect(days).toHaveLength(31);
    expect(days.every((day) => day.className.includes('day-circle'))).toBe(true);
  });

  it('只显示本月日期，不补上个月与下个月', async () => {
    await openCalendar([makeCard()]);
    await screen.findByText('2025 年 3 月');

    const dates = screen.getAllByTestId('calendar-day').map((day) => day.getAttribute('data-date'));
    expect(dates.every((date) => date?.startsWith('2025-03'))).toBe(true);
    expect(dates).not.toContain('2025-02-28');
    expect(dates).not.toContain('2025-04-01');
  });

  it('首末周按本月实际天数排，不补满 7 列', async () => {
    await openCalendar([makeCard()]);
    await screen.findByText('2025 年 3 月');

    // 周以周一起、周日止：03-01 是周六 → 首周 1 天；03-30 是周一 → 末周含 30、31 两天
    expect(weekOf('2025-03-01').getAttribute('data-days')).toBe('1');
    expect(weekOf('2025-03-31').getAttribute('data-days')).toBe('2');
    // 完整周仍是 7 天
    expect(weekOf('2025-03-10').getAttribute('data-days')).toBe('7');
    // 3 月跨 6 周：1 + 7 + 7 + 7 + 7 + 2 = 31，且不补上下月日期
    const weekLengths = screen
      .getAllByTestId('calendar-week')
      .map((week) => Number(week.getAttribute('data-days')));
    expect(weekLengths).toEqual([1, 7, 7, 7, 7, 2]);
  });

  it('每个日期圆对齐到它所属的星期几那一列', async () => {
    await openCalendar([makeCard()]);
    await screen.findByText('2025 年 3 月');

    // 03-01 是周六 → grid 第 6 列，不会被挤到第 1 列
    expect((document.querySelector('[data-date="2025-03-01"]') as HTMLElement).style.gridColumn).toBe('6');
    // 03-02 是周日 → grid 第 7 列
    expect((document.querySelector('[data-date="2025-03-02"]') as HTMLElement).style.gridColumn).toBe('7');
    // 03-03 是周一 → 第 1 列
    expect((document.querySelector('[data-date="2025-03-03"]') as HTMLElement).style.gridColumn).toBe('1');
    // 03-05 是周三 → 第 3 列
    expect((document.querySelector('[data-date="2025-03-05"]') as HTMLElement).style.gridColumn).toBe('3');
    // 03-31 是周一 → 第 1 列
    expect((document.querySelector('[data-date="2025-03-31"]') as HTMLElement).style.gridColumn).toBe('1');
  });

  it('每一周的栅格都是 7 列，首末周靠空列保持对齐', async () => {
    await openCalendar([makeCard()]);
    await screen.findByText('2025 年 3 月');

    for (const week of screen.getAllByTestId('calendar-week')) {
      expect((week as HTMLElement).style.gridTemplateColumns).toContain('repeat(7');
    }
  });

  it('今天用实心圆标出', async () => {
    await openCalendar([makeCard()]);
    await screen.findByText('2025 年 3 月');

    expect(document.querySelector('[data-date="2025-03-05"]')?.className).toContain('day-circle--today');
  });

  it('闰年 2 月排 29 天', async () => {
    const { cardApi, settingsApi } = makeApis([]);
    render(<App api={cardApi} settingsApi={settingsApi} today="2024-02-10" />);
    await userEvent.click(await screen.findByRole('tab', { name: '日历视图' }));

    expect(screen.getAllByTestId('calendar-day')).toHaveLength(29);
  });
});

describe('区间：圆—矩形—圆', () => {
  it('多日安排渲染成区间，起始与结束各一个圆，中间是矩形', async () => {
    await openCalendar([makeCard({ title: '选课安排', schedule: schedule('2025-03-05', '2025-03-08') })]);
    await screen.findByText('2025 年 3 月');

    const spans = spansInWeek('2025-03-05');
    expect(spans).toHaveLength(1);
    const span = spans[0] as HTMLElement;
    expect(span.className).toContain('span--multi');
    // 本周内完整区间：两端都是圆（cap），没有平头（edge）
    expect(span.querySelectorAll('.span__cap')).toHaveLength(2);
    expect(span.querySelectorAll('.span__edge')).toHaveLength(0);
    expect(span.querySelector('.span__bar')?.textContent).toBe('选课安排');
  });

  it('单日安排只画一个圆，不画矩形', async () => {
    await openCalendar([makeCard({ title: '单日安排', schedule: schedule('2025-03-06') })]);
    await screen.findByText('2025 年 3 月');

    const spans = spansInWeek('2025-03-06');
    expect(spans[0]?.className).toContain('span--single');
  });

  it('区间横跨多列，用 gridColumn 表达起止', async () => {
    await openCalendar([makeCard({ schedule: schedule('2025-03-05', '2025-03-07') })]);
    await screen.findByText('2025 年 3 月');

    const span = spansInWeek('2025-03-05')[0] as HTMLElement;
    // 列下标按星期几：03-05 是周三（下标 2）→ grid 第 3 列起；
    // 03-07 是周五（下标 4）→ grid 到第 6 列前，即 3 / 6
    expect(span.style.gridColumn).toBe('3 / 6');
  });

  it('跨周区间被切成两段，各自用平头示意未结束', async () => {
    // 3 月 6 日（周四）到 3 月 11 日（下周二）跨周
    await openCalendar([makeCard({ id: 'cross', schedule: schedule('2025-03-06', '2025-03-11') })]);
    await screen.findByText('2025 年 3 月');

    // 第一段：03-02~03-08 那一周。起点在本周（左侧有圆），终点在下周（右侧平头）
    const firstSegment = spanSegment('cross', '2025-03-06') as HTMLElement;
    expect(firstSegment).not.toBeNull();
    expect(firstSegment.querySelectorAll('.span__cap--start')).toHaveLength(1);
    expect(firstSegment.querySelectorAll('.span__edge--start')).toHaveLength(0);
    expect(firstSegment.querySelectorAll('.span__cap--end')).toHaveLength(0);
    expect(firstSegment.querySelectorAll('.span__edge--end')).toHaveLength(1);

    // 第二段：03-09~03-15 那一周。起点在上周（左侧平头），终点在本周（右侧有圆）
    const secondSegment = spanSegment('cross', '2025-03-10') as HTMLElement;
    expect(secondSegment).not.toBeNull();
    expect(secondSegment.querySelectorAll('.span__edge--start')).toHaveLength(1);
    expect(secondSegment.querySelectorAll('.span__cap--start')).toHaveLength(0);
    expect(secondSegment.querySelectorAll('.span__edge--end')).toHaveLength(0);
    expect(secondSegment.querySelectorAll('.span__cap--end')).toHaveLength(1);

    // 两段颜色一致，读起来才像一条连续的安排
    expect(firstSegment.style.getPropertyValue('--span-color')).toBe(
      secondSegment.style.getPropertyValue('--span-color'),
    );
  });

  it('本周没有事件时不出现区间', async () => {
    await openCalendar([makeCard({ schedule: schedule('2025-03-05') })]);
    await screen.findByText('2025 年 3 月');

    // 3 月 17 日那一周没有任何安排
    expect(weekOf('2025-03-17').querySelectorAll('[data-testid="calendar-span"]')).toHaveLength(0);
  });

  it('区间有重合时换到下一行，不重合并用同一行', async () => {
    await openCalendar([
      makeCard({ id: 'a', title: '甲', schedule: schedule('2025-03-05', '2025-03-07') }),
      makeCard({ id: 'b', title: '乙', schedule: schedule('2025-03-06', '2025-03-08') }),
      // 丙与甲、乙都不重合，应该回到第一行
      makeCard({ id: 'c', title: '丙', schedule: schedule('2025-03-03') }),
    ]);
    await screen.findByText('2025 年 3 月');

    const spans = spansInWeek('2025-03-05');
    const rows = new Map(spans.map((span) => [span.style.gridRow, span]));

    const rowOf = (id: string) => spans.find((span) => span.getAttribute('data-card-id') === id)?.style.gridRow;
    expect(rowOf('a')).not.toBe(rowOf('b'));
    expect(rowOf('c')).toBe(rowOf('a'));
    expect(rows.size).toBe(2);
  });

  it('同一日期上的两条区间颜色不同', async () => {
    await openCalendar([
      makeCard({ id: 'card-1', title: '活动甲', schedule: schedule('2025-03-05', '2025-03-07') }),
      makeCard({ id: 'card-2', title: '活动乙', schedule: schedule('2025-03-05', '2025-03-07') }),
    ]);
    await screen.findByText('2025 年 3 月');

    const colors = spansInWeek('2025-03-05').map((span) => span.style.getPropertyValue('--span-color'));
    expect(colors).toHaveLength(2);
    expect(new Set(colors).size).toBe(2);
  });

  it('同一条区间在各个周里颜色一致', async () => {
    await openCalendar([makeCard({ id: 'stable', schedule: schedule('2025-03-07', '2025-03-10') })]);
    await screen.findByText('2025 年 3 月');

    const first = spansInWeek('2025-03-07')[0]?.style.getPropertyValue('--span-color');
    const second = spansInWeek('2025-03-10')[0]?.style.getPropertyValue('--span-color');
    expect(first).toBe(second);
  });
});

describe('未排期与空态', () => {
  it('解析不出日期的卡片不进日历，并如实告知', async () => {
    await openCalendar([
      makeCard({ id: 'scheduled', title: '有日期', schedule: schedule('2025-03-05') }),
      makeCard({ id: 'none', title: '时间待定', schedule: null }),
    ]);
    await screen.findByText('2025 年 3 月');

    const labels = [...document.querySelectorAll('.span__label')].map((el) => el.textContent);
    expect(labels).toContain('有日期');
    expect(labels).not.toContain('时间待定');
    expect(screen.getByText(/没能解析出日期/)).toBeInTheDocument();
  });

  it('全部都有日期时不显示未排期提示', async () => {
    await openCalendar([makeCard()]);
    await screen.findByText('2025 年 3 月');
    expect(screen.queryByText(/没能解析出日期/)).not.toBeInTheDocument();
  });

  it('没有任何卡片时仍渲染整月，只是没有区间', async () => {
    await openCalendar([]);
    await screen.findByText('2025 年 3 月');

    expect(screen.getAllByTestId('calendar-day')).toHaveLength(31);
    expect(document.querySelectorAll('[data-testid="calendar-span"]')).toHaveLength(0);
  });

  it('加载中显示占位', async () => {
    const cardApi: CardApi = {
      listCards: vi.fn(() => new Promise<CardView[]>(() => undefined)),
      createCard: vi.fn(async () => makeCard()),
      deleteCard: vi.fn(async () => undefined),
    };
    render(<App api={cardApi} settingsApi={makeApis([]).settingsApi} today={TODAY} />);
    await userEvent.click(await screen.findByRole('tab', { name: '日历视图' }));

    expect(screen.getByRole('status')).toHaveTextContent('正在读取历史信息卡…');
  });
});

describe('月份导航', () => {
  it('默认显示今天所在月份', async () => {
    await openCalendar([makeCard()]);
    expect(await screen.findByText('2025 年 3 月')).toBeInTheDocument();
  });

  it('可以翻月并跨年', async () => {
    await openCalendar([makeCard()]);
    await screen.findByText('2025 年 3 月');

    await userEvent.click(screen.getByRole('button', { name: '下个月' }));
    expect(screen.getByText('2025 年 4 月')).toBeInTheDocument();

    for (let index = 0; index < 9; index += 1) {
      await userEvent.click(screen.getByRole('button', { name: '下个月' }));
    }
    expect(screen.getByText('2026 年 1 月')).toBeInTheDocument();
  });

  it('今天按钮回到当月并选中今天', async () => {
    await openCalendar([makeCard()]);
    await screen.findByText('2025 年 3 月');

    await userEvent.click(screen.getByRole('button', { name: '下个月' }));
    await userEvent.click(screen.getByRole('button', { name: '今天' }));

    expect(screen.getByText('2025 年 3 月')).toBeInTheDocument();
    expect(screen.getByTestId('calendar-detail')).toHaveTextContent('3月5日');
  });
});

describe('点日期看当天安排', () => {
  it('点日期显示当天安排', async () => {
    await openCalendar([makeCard({ title: '选课安排', schedule: schedule('2025-03-06', '2025-03-07') })]);
    await screen.findByText('2025 年 3 月');

    await userEvent.click(document.querySelector('[data-date="2025-03-06"]') as HTMLElement);

    const detail = await screen.findByTestId('calendar-detail');
    expect(detail).toHaveTextContent('3月6日');
    expect(detail).toHaveTextContent('选课安排');
    expect(detail).toHaveTextContent('共 2 天');
  });

  it('点空白日期说明这天没有安排', async () => {
    await openCalendar([makeCard({ schedule: schedule('2025-03-06') })]);
    await screen.findByText('2025 年 3 月');

    await userEvent.click(document.querySelector('[data-date="2025-03-20"]') as HTMLElement);
    expect(await screen.findByTestId('calendar-detail')).toHaveTextContent('这天没有安排');
  });

  it('再次点击同一天收起详情', async () => {
    await openCalendar([makeCard({ schedule: schedule('2025-03-06') })]);
    await screen.findByText('2025 年 3 月');

    const circle = document.querySelector('[data-date="2025-03-06"]') as HTMLElement;
    await userEvent.click(circle);
    await screen.findByTestId('calendar-detail');
    await userEvent.click(circle);
    await waitFor(() => expect(screen.queryByTestId('calendar-detail')).not.toBeInTheDocument());
  });

  it('点区间也能打开详情', async () => {
    await openCalendar([makeCard({ title: '跨天活动', schedule: schedule('2025-03-05', '2025-03-07') })]);
    await screen.findByText('2025 年 3 月');

    await userEvent.click(spansInWeek('2025-03-05')[0] as HTMLElement);

    const detail = await screen.findByTestId('calendar-detail');
    expect(detail).toHaveTextContent('跨天活动');
  });

  it('年份为推断所得时如实提示', async () => {
    await openCalendar([makeCard({ schedule: schedule('2025-03-06') })]);
    await screen.findByText('2025 年 3 月');

    await userEvent.click(document.querySelector('[data-date="2025-03-06"]') as HTMLElement);
    expect(await screen.findByTestId('calendar-detail')).toHaveTextContent('年份为推断所得');
  });
});

describe('荧光笔颜色自定义', () => {
  it('可以改单日颜色', async () => {
    const { settingsApi } = await openCalendar([makeCard()]);
    await screen.findByText('2025 年 3 月');

    await userEvent.click(screen.getByRole('button', { name: '荧光笔颜色' }));
    await userEvent.click(screen.getByRole('button', { name: '单日颜色 #4a7c8c' }));

    await waitFor(() =>
      expect(settingsApi.updateSettings).toHaveBeenCalledWith({ highlight: { singleDay: '#4a7c8c' } }),
    );
  });

  it('改色后区间立刻用新颜色', async () => {
    const settings = makeSettings({
      highlight: { ...makeSettings().highlight, perCard: { 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee': '#7a5c8e' } },
    });
    await openCalendar([makeCard({ schedule: schedule('2025-03-05', '2025-03-07') })], settings);
    await screen.findByText('2025 年 3 月');

    const span = spansInWeek('2025-03-05')[0] as HTMLElement;
    expect(span.style.getPropertyValue('--span-color')).toBe('#7a5c8e');
  });

  it('可以为某一条单独改颜色', async () => {
    const card = makeCard({ id: 'special-card', title: '特殊安排', schedule: schedule('2025-03-06') });
    const { settingsApi } = await openCalendar([card]);
    await screen.findByText('2025 年 3 月');

    await userEvent.click(document.querySelector('[data-date="2025-03-06"]') as HTMLElement);
    const detail = await screen.findByTestId('calendar-detail');
    await userEvent.click(within(detail).getByRole('button', { name: '改颜色' }));
    await userEvent.click(within(detail).getByRole('button', { name: '把这条改为 #7a5c8e' }));

    await waitFor(() =>
      expect(settingsApi.updateSettings).toHaveBeenCalledWith({
        highlight: { perCard: { 'special-card': '#7a5c8e' } },
      }),
    );
  });

  it('已单独指定过的卡片可以恢复默认', async () => {
    const card = makeCard({ id: 'special-card', schedule: schedule('2025-03-06') });
    const settings = makeSettings({
      highlight: { ...makeSettings().highlight, perCard: { 'special-card': '#7a5c8e' } },
    });
    const { settingsApi } = await openCalendar([card], settings);
    await screen.findByText('2025 年 3 月');

    await userEvent.click(document.querySelector('[data-date="2025-03-06"]') as HTMLElement);
    const detail = await screen.findByTestId('calendar-detail');
    await userEvent.click(within(detail).getByRole('button', { name: '改颜色' }));
    await userEvent.click(within(detail).getByRole('button', { name: '恢复默认' }));

    await waitFor(() =>
      expect(settingsApi.updateSettings).toHaveBeenCalledWith({
        highlight: { perCard: { 'special-card': null } },
      }),
    );
  });

  it('未单独指定时不显示恢复默认', async () => {
    await openCalendar([makeCard({ schedule: schedule('2025-03-06') })]);
    await screen.findByText('2025 年 3 月');

    await userEvent.click(document.querySelector('[data-date="2025-03-06"]') as HTMLElement);
    const detail = await screen.findByTestId('calendar-detail');
    await userEvent.click(within(detail).getByRole('button', { name: '改颜色' }));

    expect(within(detail).queryByRole('button', { name: '恢复默认' })).not.toBeInTheDocument();
  });

  it('改颜色不弹"设置已保存"打扰用户', async () => {
    await openCalendar([makeCard()]);
    await screen.findByText('2025 年 3 月');

    await userEvent.click(screen.getByRole('button', { name: '荧光笔颜色' }));
    await userEvent.click(screen.getByRole('button', { name: '单日颜色 #4a7c8c' }));

    await waitFor(() => expect(screen.queryByText('设置已保存')).not.toBeInTheDocument());
  });
});
