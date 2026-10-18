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
