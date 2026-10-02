import { useMemo, useState } from 'react';
import type { HighlightStyle, UpdateSettingsRequest } from '@notification-hub/shared';
import type { CardView } from '../lib/card-view';
import {
  buildMonthWeeks,
  CALENDAR_COLUMNS,
  countUnscheduled,
  isDateInSchedule,
  resolveCardColor,
  shiftMonth,
  splitIsoDate,
  type CalendarWeek,
  type ScheduleSpan,
} from '../lib/calendar';

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

/** 可选的荧光笔颜色；数量刻意有限，避免变成调色板选择困难 */
const COLOR_SWATCHES = [
  '#b4643f', '#4a7c8c', '#8a6d3b', '#7a5c8e', '#4f7a52',
  '#a05252', '#3f6f9c', '#8c5a72', '#5d6b3a', '#7a7a7a',
];

interface CalendarViewProps {
  cards: CardView[];
  loading: boolean;
  highlight: HighlightStyle;
  /** 保存颜色配置；perCard 传 null 表示取消对这张卡的单独指定 */
  onSaveHighlight: (patch: UpdateSettingsRequest) => Promise<boolean>;
  /** 今天，格式 YYYY-MM-DD；注入是为了测试可确定 */
  today: string;
}

function formatDateLabel(date: string): string {
  const parts = splitIsoDate(date);
  if (!parts) return date;
  const weekday = new Date(parts.year, parts.month - 1, parts.day).getDay();
  const label = WEEKDAY_LABELS[weekday === 0 ? 6 : weekday - 1];
  return `${parts.month}月${parts.day}日 周${label}`;
}

/**
 * 日历视图：以周为行，圆点表示日期，区间用「圆—矩形—圆」拉出来。
 *
 * 布局来自用户的要求：
 *   - 每个周的第一行是本周的日期（圆形），只显示本月的日子，
 *     本月只有 4 天就只画 4 个圆——补位空格正是之前界面显得空荡的原因。
 *   - 有事件时在其下方一行画持续区间：起始与结束各一个圆，中间用等宽矩形连接。
 *   - 同一周里区间有重合就换到下一行，不重合的共用一行，避免行数虚增。
 *   - 本周没有任何事件就不画事件行。
 */
export function CalendarView({ cards, loading, highlight, onSaveHighlight, today }: CalendarViewProps) {
  const todayParts = splitIsoDate(today);
  const [cursor, setCursor] = useState(() => ({
    year: todayParts?.year ?? new Date().getFullYear(),
    month: todayParts?.month ?? new Date().getMonth() + 1,
  }));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [showColorPanel, setShowColorPanel] = useState(false);

  const weeks = useMemo(
    () => buildMonthWeeks({ year: cursor.year, month: cursor.month, today, cards }),
    [cursor.year, cursor.month, today, cards],
  );
  const unscheduled = useMemo(() => countUnscheduled(cards), [cards]);
  const multiDayCards = useMemo(
    () => cards.filter((card) => (card.schedule?.dayCount ?? 0) >= 2),
    [cards],
  );

  /** 选中日期当天的安排 */
  const selectedCards = useMemo(() => {
    if (!selectedDate) return [];
    return cards.filter((card) => isDateInSchedule(selectedDate, card.schedule));
  }, [cards, selectedDate]);

  function go(delta: number) {
    setCursor((current) => shiftMonth(current.year, current.month, delta));
    setSelectedDate(null);
  }

  function goToday() {
    if (todayParts) setCursor({ year: todayParts.year, month: todayParts.month });
    setSelectedDate(today);
  }

  async function setCardColor(cardId: string, color: string | null) {
    await onSaveHighlight({ highlight: { perCard: { [cardId]: color } } });
    setEditingCardId(null);
  }

  function renderSpan(span: ScheduleSpan<CardView>, week: CalendarWeek<CardView>) {
    const color = resolveCardColor(span.card, highlight);
    const isMulti = (span.card.schedule?.dayCount ?? 1) >= 2;
    // 圆只画在"区间真正开始/结束的那一天"。
    // 刻意不看列下标：从上周延续过来的段即使落在第 1 列，也不是起点，
    // 画成圆会让人以为安排从那周的头一天才开始。
    const showStart = span.startsHere;
    const showEnd = span.endsHere;

    return (
      <button
        key={`${week.days[0]?.date ?? 'w'}-${span.card.id}`}
        type="button"
        className={isMulti ? 'span span--multi' : 'span span--single'}
        data-testid="calendar-span"
        data-card-id={span.card.id}
        style={{
          gridColumn: `${span.startColumn + 1} / ${span.endColumn + 2}`,
          gridRow: span.lane + 2,
          ['--span-color' as string]: color,
        }}
        title={`${span.card.title}（${span.card.schedule?.label ?? ''}）`}
        onClick={() =>
          setSelectedDate(
            // 点区间时优先跳到区间的起始日；跨周延续过来的段则落在本周第一天
            span.startsHere ? (span.card.schedule?.start ?? null) : (week.days[0]?.date ?? null),
          )
        }
      >
        {/* 起始圆：区间从更早的周延续过来时不画，改为平头，示意还没结束 */}
        <span className={showStart ? 'span__cap span__cap--start' : 'span__edge span__edge--start'} />
        <span className="span__bar">
          <span className="span__label">{span.card.title}</span>
        </span>
        <span className={showEnd ? 'span__cap span__cap--end' : 'span__edge span__edge--end'} />
      </button>
    );
  }

  return (
    <div className="calendar">
      <div className="calendar__toolbar">
        <div className="calendar__nav">
          <button type="button" className="button button--ghost" onClick={() => go(-1)} aria-label="上个月">
            ‹
          </button>
          <span className="calendar__title">
            {cursor.year} 年 {cursor.month} 月
          </span>
          <button type="button" className="button button--ghost" onClick={() => go(1)} aria-label="下个月">
            ›
          </button>
          <button type="button" className="button button--ghost" onClick={goToday}>
            今天
          </button>
        </div>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => setShowColorPanel((value) => !value)}
          aria-expanded={showColorPanel}
        >
          荧光笔颜色
        </button>
      </div>

      {showColorPanel ? (
        <div className="calendar__colors">
          <div className="calendar__colors-row">
            <span className="calendar__colors-label">单日</span>
            {COLOR_SWATCHES.map((color) => (
              <button
                key={`single-${color}`}
                type="button"
                className={highlight.singleDay === color ? 'swatch swatch--active' : 'swatch'}
                style={{ background: color }}
                aria-label={`单日颜色 ${color}`}
                onClick={() => void onSaveHighlight({ highlight: { singleDay: color } })}
              />
            ))}
          </div>
          <div className="calendar__colors-row">
            <span className="calendar__colors-label">多日</span>
            {highlight.multiDayPalette.map((color, index) => (
              <span key={`palette-${index}`} className="swatch swatch--palette" style={{ background: color }}>
                {COLOR_SWATCHES.map((candidate) => (
                  <button
                    key={`palette-${index}-${candidate}`}
                    type="button"
                    className="swatch swatch__option"
                    style={{ background: candidate }}
                    aria-label={`第 ${index + 1} 个多日颜色改为 ${candidate}`}
                    onClick={() => {
                      const next = [...highlight.multiDayPalette];
                      next[index] = candidate;
                      void onSaveHighlight({ highlight: { multiDayPalette: next } });
                    }}
                  />
                ))}
              </span>
            ))}
          </div>
          <p className="calendar__hint">
            多日区间的颜色按顺序循环，保证相邻安排颜色不同。想单独改某一条，
            点日期后在该条目上点「改颜色」。
          </p>
        </div>
      ) : null}

      {unscheduled > 0 ? (
        <p className="calendar__notice">
          有 <strong>{unscheduled}</strong> 张卡没能解析出日期（例如时间是「待定」「未识别」），
          因此没有排进日历。
        </p>
      ) : null}

      <div
        className="calendar__weekdays"
        style={{ gridTemplateColumns: `repeat(${CALENDAR_COLUMNS}, minmax(0, 1fr))` }}
      >
        {WEEKDAY_LABELS.map((label) => (
          <span key={label} className="calendar__weekday">
            {label}
          </span>
        ))}
      </div>

      {loading ? (
        <div className="state state--loading" role="status">
          正在读取历史信息卡…
        </div>
      ) : (
        <div className="calendar__weeks">
          {weeks.map((week) => (
            <div
              key={week.days[0]?.date ?? 'week'}
              className="calendar__week"
              data-testid="calendar-week"
              data-days={week.days.length}
              style={{ gridTemplateColumns: `repeat(${CALENDAR_COLUMNS}, minmax(0, 1fr))` }}
            >
              {/* 第一行：本周日期，圆形，仅本月。
                  固定 7 列栅格，日期按星期几落到自己的那一列，
                  所以首末周可能出现空列——这正是与星期表头对齐的代价。 */}
              {week.days.map((day, index) => {
                const classes = ['day-circle'];
                if (day.isToday) classes.push('day-circle--today');
                if (selectedDate === day.date) classes.push('day-circle--selected');
                return (
                  <button
                    key={day.date}
                    type="button"
                    className={classes.join(' ')}
                    data-testid="calendar-day"
                    data-date={day.date}
                    style={{ gridColumn: (week.dayColumns[index] ?? 0) + 1, gridRow: 1 }}
                    onClick={() => setSelectedDate(day.date === selectedDate ? null : day.date)}
                  >
                    {day.day}
                  </button>
                );
              })}

              {/* 第二行起：区间。无事件时这一块为空，整周就只有日期那一行 */}
              {week.spans.map((span) => renderSpan(span, week))}
            </div>
          ))}
        </div>
      )}

      {selectedDate ? (
        <div className="calendar__detail" data-testid="calendar-detail">
          <h3 className="calendar__detail-title">{formatDateLabel(selectedDate)}</h3>
          {selectedCards.length === 0 ? (
            <p className="calendar__detail-empty">这天没有安排。</p>
          ) : (
            <ul className="calendar__detail-list">
              {selectedCards.map((card) => {
                const isMulti = (card.schedule?.dayCount ?? 1) >= 2;
                const isFirstDay = card.schedule?.start === selectedDate;
                const isLastDay = card.schedule?.end === selectedDate;
                return (
                  <li key={card.id} className="calendar__detail-item">
                    <span
                      className="calendar__detail-dot"
                      style={{ background: resolveCardColor(card, highlight) }}
                      aria-hidden="true"
                    />
                    <div className="calendar__detail-body">
                      <div className="calendar__detail-name">{card.title}</div>
                      <div className="calendar__detail-meta">
                        {card.schedule?.label ? <span>{card.schedule.label}</span> : null}
                        {isMulti ? (
                          <span className="calendar__detail-span">
                            共 {card.schedule?.dayCount} 天
                            {isFirstDay ? '（起始）' : ''}
                            {isLastDay && !isFirstDay ? '（结束）' : ''}
                          </span>
                        ) : null}
                        {card.schedule?.inferredYear ? (
                          <span className="calendar__detail-inferred">年份为推断所得</span>
                        ) : null}
                      </div>
                    </div>
                    {editingCardId === card.id ? (
                      <span className="calendar__detail-colors">
                        {COLOR_SWATCHES.map((color) => (
                          <button
                            key={color}
                            type="button"
                            className="swatch swatch--small"
                            style={{ background: color }}
                            aria-label={`把这条改为 ${color}`}
                            onClick={() => void setCardColor(card.id, color)}
                          />
                        ))}
                        {highlight.perCard[card.id] ? (
                          <button
                            type="button"
                            className="button button--danger"
                            onClick={() => void setCardColor(card.id, null)}
                          >
                            恢复默认
                          </button>
                        ) : null}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="button button--ghost"
                        onClick={() => setEditingCardId(card.id)}
                      >
                        改颜色
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}

      {multiDayCards.length > 0 ? (
        <p className="calendar__hint calendar__hint--legend">
          多日安排 {multiDayCards.length} 条，已在对应周里拉成区间：
          {multiDayCards.slice(0, 6).map((card) => (
            <span key={card.id} className="calendar__legend-item">
              <span
                className="calendar__legend-dot"
                style={{ background: resolveCardColor(card, highlight) }}
                aria-hidden="true"
              />
              {card.title}（{card.schedule?.dayCount} 天）
            </span>
          ))}
          {multiDayCards.length > 6 ? <span>等</span> : null}
        </p>
      ) : null}
    </div>
  );
}
