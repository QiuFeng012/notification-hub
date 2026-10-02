import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_HIGHLIGHT_STYLE } from '@notification-hub/shared';
import type { CardSchedule, SettingsView } from '@notification-hub/shared';
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
    },
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

/** 取某个日期格里的所有标记 */
function marksOn(date: string): HTMLElement[] {
  const cell = document.querySelector(`[data-date="${date}"]`);
  return cell ? [...cell.querySelectorAll('[data-testid="calendar-mark"]')] as HTMLElement[] : [];
}

describe('视图切换', () => {
  it('默认显示卡片列表', async () => {
    const { cardApi, settingsApi } = makeApis([makeCard()]);
    render(<App api={cardApi} settingsApi={settingsApi} today={TODAY} />);

    expect(await screen.findByTestId('info-card')).toBeInTheDocument();
    expect(screen.queryByTestId('calendar-cell')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '卡片列表' })).toHaveAttribute('aria-selected', 'true');
  });

  it('切到日历后显示月历网格，再切回来恢复列表', async () => {
    await openCalendar([makeCard()]);

    expect(screen.getAllByTestId('calendar-cell').length).toBeGreaterThan(27);
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

describe('日历排期', () => {
  it('卡片出现在它覆盖的每一天', async () => {
    await openCalendar([makeCard({ title: '选课安排', schedule: schedule('2025-03-05', '2025-03-08') })]);

    await screen.findByText('2025 年 3 月');
    for (const date of ['2025-03-05', '2025-03-06', '2025-03-07', '2025-03-08']) {
      expect(marksOn(date).map((mark) => mark.textContent)).toEqual(['选课安排']);
    }
    expect(marksOn('2025-03-09')).toHaveLength(0);
  });

  it('单日卡片只出现在那一天，且用描边样式而不是实心荧光笔', async () => {
    await openCalendar([makeCard({ title: '单日安排', schedule: schedule('2025-03-06') })]);
    await screen.findByText('2025 年 3 月');

    const marks = marksOn('2025-03-06');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.className).not.toContain('calendar__mark--multi');
  });

  it('多日卡片用实心荧光笔', async () => {
    await openCalendar([makeCard({ title: '多日安排', schedule: schedule('2025-03-05', '2025-03-07') })]);
    await screen.findByText('2025 年 3 月');

    const marks = marksOn('2025-03-05');
    expect(marks[0]?.className).toContain('calendar__mark--multi');
  });

  it('同一条多日卡片在整段区间里颜色一致', async () => {
    const settings = makeSettings();
    await openCalendar(
      [makeCard({ title: '跨天活动', schedule: schedule('2025-03-05', '2025-03-08') })],
      settings,
    );
    await screen.findByText('2025 年 3 月');

    const colors = ['2025-03-05', '2025-03-06', '2025-03-07', '2025-03-08'].map(
      (date) => marksOn(date)[0]?.style.background,
    );
    expect(new Set(colors).size).toBe(1);
    expect(colors[0]).not.toBe('');
  });

  it('两条多日卡片的颜色不同', async () => {
    await openCalendar([
      makeCard({ id: 'card-1', title: '活动甲', schedule: schedule('2025-03-05', '2025-03-07') }),
      makeCard({ id: 'card-2', title: '活动乙', schedule: schedule('2025-03-05', '2025-03-07') }),
    ]);
    await screen.findByText('2025 年 3 月');

    const marks = marksOn('2025-03-05');
    const colors = marks.map((mark) => mark.style.background);
    expect(marks).toHaveLength(2);
    // 调色板里至少有多种颜色，两张卡不应撞成同一个
    expect(new Set(colors).size).toBe(2);
  });

  it('解析不出日期的卡片不进日历，并如实告知', async () => {
    await openCalendar([
      makeCard({ id: 'scheduled', title: '有日期', schedule: schedule('2025-03-05') }),
      makeCard({ id: 'none', title: '时间待定', schedule: null }),
    ]);
    await screen.findByText('2025 年 3 月');

    const allMarks = [...document.querySelectorAll('[data-testid="calendar-mark"]')].map((el) => el.textContent);
    expect(allMarks).toContain('有日期');
    expect(allMarks).not.toContain('时间待定');
    expect(screen.getByText(/没能解析出日期/)).toBeInTheDocument();
  });

  it('全部卡片都有日期时不显示未排期提示', async () => {
    await openCalendar([makeCard()]);
    await screen.findByText('2025 年 3 月');

    expect(screen.queryByText(/没能解析出日期/)).not.toBeInTheDocument();
  });
});

describe('月份导航', () => {
  it('默认显示今天所在月份', async () => {
    await openCalendar([makeCard()]);
    expect(await screen.findByText('2025 年 3 月')).toBeInTheDocument();
  });

  it('可以翻到上个月与下个月', async () => {
    await openCalendar([makeCard()]);
    await screen.findByText('2025 年 3 月');

    await userEvent.click(screen.getByRole('button', { name: '下个月' }));
    expect(screen.getByText('2025 年 4 月')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '上个月' }));
    await userEvent.click(screen.getByRole('button', { name: '上个月' }));
    expect(screen.getByText('2025 年 2 月')).toBeInTheDocument();
  });

  it('回到今天回到当月并选中今天', async () => {
    await openCalendar([makeCard()]);
    await screen.findByText('2025 年 3 月');

    await userEvent.click(screen.getByRole('button', { name: '下个月' }));
    await userEvent.click(screen.getByRole('button', { name: '回到今天' }));

    expect(screen.getByText('2025 年 3 月')).toBeInTheDocument();
    expect(screen.getByTestId('calendar-detail')).toHaveTextContent('3月5日');
  });
});

describe('点日期看当天安排', () => {
  it('点有安排的日期显示当天卡片', async () => {
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

    const cell = document.querySelector('[data-date="2025-03-06"]') as HTMLElement;
    await userEvent.click(cell);
    await screen.findByTestId('calendar-detail');

    await userEvent.click(cell);
    await waitFor(() => expect(screen.queryByTestId('calendar-detail')).not.toBeInTheDocument());
  });

  it('年份为推断所得时如实提示，不假装精确', async () => {
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

  it('改单日颜色后，日格上的单日卡片立刻用新颜色', async () => {
    const settings = makeSettings({ highlight: { ...makeSettings().highlight, singleDay: '#4a7c8c' } });
    await openCalendar([makeCard({ title: '单日安排', schedule: schedule('2025-03-06') })], settings);
    await screen.findByText('2025 年 3 月');

    const mark = marksOn('2025-03-06')[0] as HTMLElement;
    expect(mark.style.color.toLowerCase()).toBe('rgb(74, 124, 140)');
  });

  it('可以为某一条单独改颜色，且颜色优先级最高', async () => {
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

  it('没有单独指定过的卡片不显示恢复默认', async () => {
    await openCalendar([makeCard({ schedule: schedule('2025-03-06') })]);
    await screen.findByText('2025 年 3 月');

    await userEvent.click(document.querySelector('[data-date="2025-03-06"]') as HTMLElement);
    const detail = await screen.findByTestId('calendar-detail');
    await userEvent.click(within(detail).getByRole('button', { name: '改颜色' }));

    expect(within(detail).queryByRole('button', { name: '恢复默认' })).not.toBeInTheDocument();
  });

  it('改颜色不会弹出"设置已保存"打扰用户', async () => {
    await openCalendar([makeCard()]);
    await screen.findByText('2025 年 3 月');

    await userEvent.click(screen.getByRole('button', { name: '荧光笔颜色' }));
    await userEvent.click(screen.getByRole('button', { name: '单日颜色 #4a7c8c' }));

    await waitFor(() => expect(screen.queryByText('设置已保存')).not.toBeInTheDocument());
  });
});

describe('日历的加载与空态', () => {
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

  it('没有任何卡片时日历仍可渲染，只是没有标记', async () => {
    await openCalendar([]);
    await screen.findByText('2025 年 3 月');

    expect(screen.getAllByTestId('calendar-cell').length).toBeGreaterThan(27);
    expect(document.querySelectorAll('[data-testid="calendar-mark"]')).toHaveLength(0);
  });
});
