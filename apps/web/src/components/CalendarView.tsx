import { useMemo, useState } from 'react';
import type {
  CardRevision,
  HighlightStyle,
  UpdateCardRequest,
  UpdateSettingsRequest,
} from '@notification-hub/shared';
import { CardEditForm } from './CardEditForm';
import { RevisionHistory } from './RevisionHistory';
import { RgbColorPicker } from './RgbColorPicker';
import type { CardView } from '../lib/card-view';
import { readableTextColor } from '../lib/color';
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

/**
 * 常用的起始色，仅作为"快捷起点"。
 * 颜色本身完全可自定义：点任意一个色块都会展开 RGB 色盘与 R/G/B 滑条。
 */
const COLOR_PRESETS = [
  '#b4643f', '#4a7c8c', '#8a6d3b', '#7a5c8e', '#4f7a52',
  '#a05252', '#3f6f9c', '#8c5a72', '#5d6b3a', '#7a7a7a',
];

/** 色盘当前在调哪个颜色 */
type ColorSlot =
  | { kind: 'single' }
  | { kind: 'multi'; index: number }
  | { kind: 'card'; cardId: string };

interface CalendarViewProps {
  cards: CardView[];
  loading: boolean;
  highlight: HighlightStyle;
  /** 保存颜色配置；perCard 传 null 表示取消对这张卡的单独指定 */
  onSaveHighlight: (patch: UpdateSettingsRequest) => Promise<boolean>;
  /** 提交对某张卡片的修改；返回是否成功 */
  onEdit: (id: string, patch: UpdateCardRequest) => Promise<boolean>;
  onLoadRevisions: (id: string) => Promise<CardRevision[]>;
  onClearRevisions: (id: string) => Promise<void>;
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
export function CalendarView({
  cards,
  loading,
  highlight,
  onSaveHighlight,
  onEdit,
  onLoadRevisions,
  onClearRevisions,
  today,
}: CalendarViewProps) {
  const todayParts = splitIsoDate(today);
  const [cursor, setCursor] = useState(() => ({
    year: todayParts?.year ?? new Date().getFullYear(),
    month: todayParts?.month ?? new Date().getMonth() + 1,
  }));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  /** 正在编辑详情的那张卡片（改标题/时间/要点） */
  const [editingDetailsId, setEditingDetailsId] = useState<string | null>(null);
  /** 正在看改动历史的那张卡片 */
  const [historyCardId, setHistoryCardId] = useState<string | null>(null);
  const [showColorPanel, setShowColorPanel] = useState(false);
  /** 颜色面板里正在用色盘细调哪个颜色 */
  const [editingSlot, setEditingSlot] = useState<ColorSlot | null>(null);
  /**
   * 拖动滑条时的实时预览色（hex → 颜色），只用于渲染，不落盘。
   * 松手后才写入设置——否则拖一次会往接口打几十个请求。
   */
  const [previewColors, setPreviewColors] = useState<Record<string, string>>({});

  /** 把预览色叠到已保存配置上，得到"当前该怎么画" */
  const styleForRender = useMemo(() => {
    const next: HighlightStyle = {
      singleDay: previewColors.single ?? highlight.singleDay,
      multiDayPalette: highlight.multiDayPalette.map((color, index) => previewColors[`multi-${index}`] ?? color),
      perCard: { ...highlight.perCard },
    };
    for (const card of cards) {
      const previewed = previewColors[`card-${card.id}`];
      if (previewed) next.perCard[card.id] = previewed;
    }
    return next;
  }, [highlight, previewColors, cards]);

  function previewColor(key: string, hex: string) {
    setPreviewColors((current) => ({ ...current, [key]: hex }));
  }

  /** 保存成功后清掉对应预览色，让它回到"以服务端为准" */
  async function commitColor(key: string, patch: UpdateSettingsRequest) {
    await onSaveHighlight(patch);
    setPreviewColors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

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

  /** 某个色盘槽位对应的预览键；每个槽位独立，避免互相覆盖 */
  function slotPreviewKey(slot: ColorSlot): string {
    if (slot.kind === 'single') return 'single';
    if (slot.kind === 'multi') return `multi-${slot.index}`;
    return `card-${slot.cardId}`;
  }

  /** 色盘当前应显示的颜色（优先取拖动中的预览色） */
  function currentSlotColor(slot: ColorSlot, style: HighlightStyle): string {
    if (slot.kind === 'single') return style.singleDay;
    if (slot.kind === 'multi') return style.multiDayPalette[slot.index] ?? style.singleDay;
    return style.perCard[slot.cardId] ?? style.singleDay;
  }

  /** 把色盘选中的颜色写进设置 */
  async function commitSlotColor(slot: ColorSlot, hex: string) {
    if (slot.kind === 'single') {
      await commitColor('single', { highlight: { singleDay: hex } });
      return;
    }
    if (slot.kind === 'multi') {
      const next = [...highlight.multiDayPalette];
      next[slot.index] = hex;
      await commitColor(`multi-${slot.index}`, { highlight: { multiDayPalette: next } });
      return;
    }
    await commitColor(`card-${slot.cardId}`, { highlight: { perCard: { [slot.cardId]: hex } } });
  }

  function renderSpan(span: ScheduleSpan<CardView>, week: CalendarWeek<CardView>) {
    const color = resolveCardColor(span.card, styleForRender);
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
          <span className="span__label" style={{ color: readableTextColor(color) }}>
            {span.card.title}
          </span>
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
            <button
              type="button"
              className="swatch swatch--current"
              style={{ background: styleForRender.singleDay }}
              aria-label="编辑单日颜色"
              onClick={() => setEditingSlot({ kind: 'single' })}
            />
            <span className="calendar__colors-value">{styleForRender.singleDay}</span>
          </div>

          <div className="calendar__colors-row">
            <span className="calendar__colors-label">多日</span>
            {styleForRender.multiDayPalette.map((color, index) => (
              <button
                key={`palette-${index}`}
                type="button"
                className="swatch swatch--current"
                style={{ background: color }}
                aria-label={`编辑第 ${index + 1} 个多日颜色`}
                onClick={() => setEditingSlot({ kind: 'multi', index })}
              />
            ))}
          </div>

          {editingSlot ? (
            <div className="calendar__colors-editor">
              <div className="calendar__colors-editor-head">
                <span className="calendar__colors-label">
                  {editingSlot.kind === 'single'
                    ? '单日颜色'
                    : editingSlot.kind === 'multi'
                      ? `第 ${editingSlot.index + 1} 个多日颜色`
                      : '这条安排的颜色'}
                </span>
                <button type="button" className="button button--ghost" onClick={() => setEditingSlot(null)}>
                  收起色盘
                </button>
              </div>

              <RgbColorPicker
                label={
                  editingSlot.kind === 'single'
                    ? '单日颜色'
                    : editingSlot.kind === 'multi'
                      ? `多日颜色 ${editingSlot.index + 1}`
                      : '这条安排的颜色'
                }
                value={currentSlotColor(editingSlot, styleForRender)}
                onChange={(hex) => previewColor(slotPreviewKey(editingSlot), hex)}
                onCommit={(hex) => void commitSlotColor(editingSlot, hex)}
              />

              <div className="calendar__colors-row">
                <span className="calendar__colors-label">快捷</span>
                {COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className="swatch"
                    style={{ background: preset }}
                    aria-label={`把当前颜色设为 ${preset}`}
                    onClick={() => void commitSlotColor(editingSlot, preset)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <p className="calendar__hint">
              点任意色块打开 RGB 色盘，可以拖 R / G / B 三条滑条精确调色。
              多日区间的颜色按顺序循环，保证相邻安排颜色不同；想单独改某一条，
              点日期后在该条目上点「改颜色」。
            </p>
          )}
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
                const edited = card.revisionCount > 0;

                // 正在改这张卡：整条换成编辑表单，避免"边看边改"时改错对象
                if (editingDetailsId === card.id) {
                  return (
                    <li key={card.id} className="calendar__detail-item calendar__detail-item--editing">
                      <CardEditForm
                        card={card}
                        onSubmit={async (patch) => {
                          const ok = await onEdit(card.id, patch);
                          if (ok) setEditingDetailsId(null);
                          return ok;
                        }}
                        onCancel={() => setEditingDetailsId(null)}
                      />
                    </li>
                  );
                }

                return (
                  <li key={card.id} className="calendar__detail-item">
                    <span
                      className="calendar__detail-dot"
                      style={{ background: resolveCardColor(card, styleForRender) }}
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
                        {edited ? (
                          <span className="calendar__detail-edited" data-testid="detail-edited">
                            已修改 {card.revisionCount} 次
                          </span>
                        ) : null}
                        {card.schedule?.inferredYear ? (
                          <span className="calendar__detail-inferred">年份为推断所得</span>
                        ) : null}
                      </div>
                      {historyCardId === card.id ? (
                        <RevisionHistory cardId={card.id} load={onLoadRevisions} onClear={onClearRevisions} />
                      ) : null}
                    </div>

                    <span className="calendar__detail-actions">
                      <button
                        type="button"
                        className="button button--ghost"
                        onClick={() => {
                          setEditingDetailsId(card.id);
                          setHistoryCardId(null);
                        }}
                        aria-label={`修改信息：${card.title}`}
                      >
                        修改
                      </button>
                      {edited ? (
                        <button
                          type="button"
                          className="button button--ghost"
                          aria-expanded={historyCardId === card.id}
                          onClick={() =>
                            setHistoryCardId((current) => (current === card.id ? null : card.id))
                          }
                        >
                          {historyCardId === card.id ? '收起历史' : '改动历史'}
                        </button>
                      ) : null}
                      {editingCardId === card.id ? (
                        <RgbColorPicker
                          label="这条安排的颜色"
                          value={resolveCardColor(card, styleForRender)}
                          onChange={(hex) => previewColor(`card-${card.id}`, hex)}
                          onCommit={(hex) =>
                            void commitColor(`card-${card.id}`, {
                              highlight: { perCard: { [card.id]: hex } },
                            })
                          }
                        />
                      ) : (
                        <button
                          type="button"
                          className="button button--ghost"
                          onClick={() => setEditingCardId(card.id)}
                        >
                          改颜色
                        </button>
                      )}
                      {editingCardId === card.id && highlight.perCard[card.id] ? (
                        <button
                          type="button"
                          className="button button--danger"
                          onClick={() =>
                            void commitColor(`card-${card.id}`, {
                              highlight: { perCard: { [card.id]: null } },
                            })
                          }
                        >
                          恢复默认
                        </button>
                      ) : null}
                    </span>
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
                style={{ background: resolveCardColor(card, styleForRender) }}
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
