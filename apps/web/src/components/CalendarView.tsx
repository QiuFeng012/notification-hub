import { useMemo, useState } from 'react';
import type { HighlightStyle, UpdateSettingsRequest } from '@notification-hub/shared';
import type { CardView } from '../lib/card-view';
import {
  buildMonthGrid,
  countUnscheduled,
  groupCardsByDate,
  isDateInSchedule,
  resolveCardColor,
  shiftMonth,
  splitIsoDate,
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

function formatMonthTitle(year: number, month: number): string {
  return `${year} 年 ${month} 月`;
}

/** 把 YYYY-MM-DD 显示成 "3月5日 周三" */
function formatDateLabel(date: string): string {
  const parts = splitIsoDate(date);
  if (!parts) return date;
  const weekday = new Date(parts.year, parts.month - 1, parts.day).getDay();
  const label = WEEKDAY_LABELS[weekday === 0 ? 6 : weekday - 1];
  return `${parts.month}月${parts.day}日 周${label}`;
}

/**
 * 日历视图：以月历为表，看哪条信息卡在哪天有安排。
 *
 * 两个刻意的设计：
 *   - 解析不出日期的卡片**不画进日历**，并在顶部如实告知数量。
 *     把它们堆在某一天会让人误以为那天真的有安排。
 *   - 多日卡片在它覆盖的每一格上都画荧光笔，颜色按卡片 id 稳定分配，
 *     所以同一条通知在整段区间里是同一种颜色，不同通知颜色不同。
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

  const byDate = useMemo(() => groupCardsByDate(cards), [cards]);
  const unscheduled = useMemo(() => countUnscheduled(cards), [cards]);
  const cells = useMemo(
    () => buildMonthGrid(cursor.year, cursor.month, today),
    [cursor.year, cursor.month, today],
  );

  const multiDayCards = useMemo(
    () => cards.filter((card) => (card.schedule?.dayCount ?? 0) >= 2),
    [cards],
  );

  const selectedCards = selectedDate ? byDate.get(selectedDate) ?? [] : [];

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

  return (
    <div className="calendar">
      <div className="calendar__toolbar">
        <div className="calendar__nav">
          <button type="button" className="button button--ghost" onClick={() => go(-1)} aria-label="上个月">
            ‹
          </button>
          <span className="calendar__title">{formatMonthTitle(cursor.year, cursor.month)}</span>
          <button type="button" className="button button--ghost" onClick={() => go(1)} aria-label="下个月">
            ›
          </button>
          <button type="button" className="button button--ghost" onClick={goToday}>
            回到今天
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
                className={
                  highlight.singleDay === color ? 'swatch swatch--active' : 'swatch'
                }
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
            多日卡片的颜色按顺序循环使用，保证相邻通知颜色不同。想单独改某一条，
            点日期后在该条目上点「改颜色」。
          </p>
        </div>
      ) : null}

      {unscheduled > 0 ? (
        <p className="calendar__notice">
          有 <strong>{unscheduled}</strong> 张卡没能解析出日期（例如时间是「待定」「未识别」），
          因此没有排进日历。补上明确日期后它们会出现在这里。
        </p>
      ) : null}

      <div className="calendar__weekdays">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label} className="calendar__weekday">
            周{label}
          </span>
        ))}
      </div>

      {loading ? (
        <div className="state state--loading" role="status">
          正在读取历史信息卡…
        </div>
      ) : (
        <div className="calendar__grid">
          {cells.map((cell) => {
            const dayCards = byDate.get(cell.date) ?? [];
            const classes = ['calendar__cell'];
            if (!cell.inMonth) classes.push('calendar__cell--outside');
            if (cell.isToday) classes.push('calendar__cell--today');
            if (selectedDate === cell.date) classes.push('calendar__cell--selected');

            return (
              <button
                key={cell.date}
                type="button"
                className={classes.join(' ')}
                data-testid="calendar-cell"
                data-date={cell.date}
                onClick={() => setSelectedDate(cell.date === selectedDate ? null : cell.date)}
              >
                <span className="calendar__day">{cell.day}</span>
                <span className="calendar__marks">
                  {dayCards.map((card) => {
                    const color = resolveCardColor(card, highlight);
                    const isMulti = (card.schedule?.dayCount ?? 1) >= 2;
                    return (
                      <span
                        key={`${cell.date}-${card.id}`}
                        className={isMulti ? 'calendar__mark calendar__mark--multi' : 'calendar__mark'}
                        data-testid="calendar-mark"
                        data-card-id={card.id}
                        style={
                          isMulti
                            ? { background: color, borderColor: color }
                            : { borderColor: color, color }
                        }
                        title={card.title}
                      >
                        {card.title}
                      </span>
                    );
                  })}
                </span>
              </button>
            );
          })}
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
                        {isDateInSchedule(selectedDate, card.schedule) && card.schedule?.inferredYear ? (
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
          多日安排共 {multiDayCards.length} 条，已用荧光笔铺满其覆盖的每一天：
          {multiDayCards.slice(0, 5).map((card) => (
            <span key={card.id} className="calendar__legend-item">
              <span
                className="calendar__legend-dot"
                style={{ background: resolveCardColor(card, highlight) }}
                aria-hidden="true"
              />
              {card.title}（{card.schedule?.dayCount} 天）
            </span>
          ))}
          {multiDayCards.length > 5 ? <span>等</span> : null}
        </p>
      ) : null}
    </div>
  );
}
