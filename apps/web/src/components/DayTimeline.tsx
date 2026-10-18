import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { CardSchedule, HighlightStyle } from '@notification-hub/shared';
import { resolveCardColor } from '../lib/calendar';
import { readableTextColor } from '../lib/color';
import type { CardView } from '../lib/card-view';
import {
  barGeometry,
  buildTimeTicks,
  formatDateLabel,
  formatSegment,
  scheduleSegmentOnDay,
  AXIS_HEIGHT,
  HOUR_WIDTH,
  PLOT_WIDTH,
  ROW_HEIGHT,
  type DaySegment,
  type TimelineUnit,
} from '../lib/day-timeline';
import { SCHEDULE_ROLE_LABELS } from '../lib/schedule-labels';

/** 时间轴上的一条：卡片 + 它的第几条日程 */
export interface TimelineEntry {
  card: CardView;
  schedule: CardSchedule;
  scheduleIndex: number;
  key: string;
}

export interface DayTimelineProps {
  /** 选中日期 YYYY-MM-DD */
  date: string;
  entries: TimelineEntry[];
  highlight: HighlightStyle;
  activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: () => void;
}

interface TimelineRowData {
  entry: TimelineEntry;
  segment: DaySegment;
}

const SHORT_BAR_WIDTH = 110;

function TimelineRow({
  row,
  index,
  highlight,
  activeKey,
  onSelect,
}: {
  row: TimelineRowData;
  index: number;
  highlight: HighlightStyle;
  activeKey: string | null;
  onSelect: (key: string) => void;
}) {
  const { entry, segment } = row;
  const { left, width } = barGeometry(segment);
  const visibleWidth = Math.max(10, width);
  const color = resolveCardColor(entry.card, highlight);
  const ink = readableTextColor(color, 'var(--span-ink-dark)', 'var(--span-ink-light)');
  const timeLabel = formatSegment(segment);
  const roleLabel =
    entry.card.schedules.length > 1 ? SCHEDULE_ROLE_LABELS[entry.schedule.role ?? 'primary'] : null;
  const fullLabel = `${entry.card.title} ${timeLabel}`;
  const isShort = width < SHORT_BAR_WIDTH;

  const barStyle = {
    left,
    width: visibleWidth,
    ['--span-color' as string]: color,
    ['--span-ink' as string]: ink,
  } as CSSProperties;

  const outsideLeft = left + visibleWidth + 6;
  const outsideOnLeft = outsideLeft + 220 > PLOT_WIDTH;
  const outsideStyle: CSSProperties = outsideOnLeft
    ? { right: `${PLOT_WIDTH - left + 6}px` }
    : { left: `${outsideLeft}px` };

  return (
    <div
      className="day-timeline__row"
      data-testid="timeline-row"
      data-row={index}
      style={{ height: ROW_HEIGHT }}
    >
      <button
        type="button"
        className={
          activeKey === entry.key
            ? 'day-timeline__bar day-timeline__bar--active'
            : 'day-timeline__bar'
        }
        data-testid="timeline-bar"
        data-entry-key={entry.key}
        data-row={index}
        data-start-min={segment.startMin}
        data-end-min={segment.endMin}
        data-has-time={segment.hasTime ? 'true' : 'false'}
        style={barStyle}
        title={fullLabel}
        aria-label={fullLabel}
        aria-pressed={activeKey === entry.key}
        onClick={() => onSelect(entry.key)}
      >
        {isShort ? (
          <span className="visually-hidden">{fullLabel}</span>
        ) : (
          <>
            {roleLabel ? <span className="day-timeline__bar-role">{roleLabel}</span> : null}
            <span className="day-timeline__bar-title">{entry.card.title}</span>
            <span className="day-timeline__bar-time">{timeLabel}</span>
          </>
        )}
      </button>

      {isShort ? (
        <span
          className="day-timeline__bar-outside"
          data-testid="timeline-bar-outside"
          style={outsideStyle}
        >
          {roleLabel ? `${roleLabel} ` : ''}
          {entry.card.title} · {timeLabel}
        </span>
      ) : null}
    </div>
  );
}

/**
 * 日期时间轴：只画第四象限。
 *
 * 左上角是选中日期；x 轴向右是 00:00–24:00；y 轴向下排事件，一个日程一行。
 * 时间只决定条的 left/width，y 只决定行号，两者互不干扰。
 */
export function DayTimeline({
  date,
  entries,
  highlight,
  activeKey,
  onSelect,
  onClose,
}: DayTimelineProps) {
  const [unit, setUnit] = useState<TimelineUnit>('hour');
  const scrollRef = useRef<HTMLDivElement>(null);

  // 换一天时回到小时刻度；单位不是需要跨日期记住的偏好
  useEffect(() => {
    setUnit('hour');
  }, [date]);

  const rows = useMemo<TimelineRowData[]>(() => {
    return entries
      .map((entry) => ({ entry, segment: scheduleSegmentOnDay(entry.schedule, date) }))
      .filter((row): row is TimelineRowData => row.segment !== null)
      .sort(
        (a, b) =>
          a.segment.startMin - b.segment.startMin ||
          a.entry.card.title.localeCompare(b.entry.card.title, 'zh-Hans-CN') ||
          a.entry.scheduleIndex - b.entry.scheduleIndex,
      );
  }, [entries, date]);

  const ticks = useMemo(() => buildTimeTicks(unit), [unit]);
  const tickStep = unit === 'hour' ? HOUR_WIDTH : HOUR_WIDTH / 2;

  // 打开时滚到第一条事件前 1 小时；空日期停在 07:00。
  // 单位切换不重新滚动，避免用户刚看的位置被抢走。
  const firstStart = rows[0]?.segment.startMin;
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const reference = firstStart ?? 7 * 60;
    node.scrollLeft = (Math.max(0, reference - 60) / 60) * HOUR_WIDTH;
   }, [date, firstStart]);

  return (
    <div className="day-timeline" data-testid="day-timeline">
      <header className="day-timeline__head">
        <div className="day-timeline__heading">
          <h3 className="day-timeline__date">{formatDateLabel(date)}</h3>
          <p className="day-timeline__hint">一个日程一行，按当天时刻定位</p>
        </div>

        <div className="day-timeline__controls">
          <div className="day-timeline__units" role="group" aria-label="时间轴单位">
            <button
              type="button"
              className={
                unit === 'hour'
                  ? 'day-timeline__unit day-timeline__unit--active'
                  : 'day-timeline__unit'
              }
              aria-pressed={unit === 'hour'}
              onClick={() => setUnit('hour')}
            >
              1 小时
            </button>
            <button
              type="button"
              className={
                unit === 'half-hour'
                  ? 'day-timeline__unit day-timeline__unit--active'
                  : 'day-timeline__unit'
              }
              aria-pressed={unit === 'half-hour'}
              onClick={() => setUnit('half-hour')}
            >
              30 分钟
            </button>
          </div>
          <button type="button" className="button button--ghost" onClick={onClose}>
            收起
          </button>
        </div>
      </header>

      <div className="day-timeline__plot">
        <div className="day-timeline__y-axis" data-testid="timeline-y-axis" aria-hidden="true">
          <span className="day-timeline__y-origin">0</span>
          {rows.map((row, index) => (
            <span
              key={row.entry.key}
              className="day-timeline__y-mark"
              data-testid="timeline-y-mark"
              style={{ top: AXIS_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2 }}
            >
              -{index + 1}
            </span>
          ))}
        </div>

        <div className="day-timeline__scroll" ref={scrollRef}>
          <div className="day-timeline__canvas" style={{ width: PLOT_WIDTH }}>
            <div
              className="day-timeline__axis"
              data-testid="timeline-axis"
              style={{ height: AXIS_HEIGHT, backgroundSize: `${tickStep}px 100%` }}
            >
              <span className="visually-hidden">时间轴 0 点到 24 点</span>
              {ticks.map((tick) => (
                <span
                  key={tick.minutes}
                  className={
                    tick.minutes === 0
                      ? 'day-timeline__tick day-timeline__tick--first'
                      : 'day-timeline__tick'
                  }
                  data-testid="timeline-tick"
                  aria-hidden="true"
                  style={{ left: (tick.minutes / 60) * HOUR_WIDTH }}
                >
                  {tick.label}
                </span>
              ))}
              <span
                className="day-timeline__axis-end"
                data-testid="timeline-axis-end"
                aria-hidden="true"
              >
                24:00
              </span>
            </div>

            <div
              className="day-timeline__rows"
              style={{ backgroundSize: `${tickStep}px 100%` }}
            >
              {rows.map((row, index) => (
                <TimelineRow
                  key={row.entry.key}
                  row={row}
                  index={index}
                  highlight={highlight}
                  activeKey={activeKey}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {rows.length === 0 ? <p className="day-timeline__empty">这天没有安排。</p> : null}
    </div>
  );
}
