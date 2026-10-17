import { useMemo, useState } from 'react';
import type {
  CardRevision,
  CardSchedule,
  HighlightStyle,
  ReExtractPreview,
  ScheduleRole,
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

// 周一在最左、周日在最右：这是用户确定的写法（一二三四五六日）
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

/**
 * 日程角色的中文标签。
 *
 * 一条通知常常同时给"报名截止"和"活动开始"两个时间，日历上会画两条。
 * 两条颜色相同，没有标签就分不清哪条是哪个——而"哪天之前要交"和
 * "哪天要去"是完全不同的两件事。
 *
 * 用「截止」而不是「报名截止」：需要按时交的不只有报名，
 * 还有"纸质缓检表交到值班台"这类，说"报名截止"会指错事。
 *
 * primary 的「主要」只在**多日期的卡片上**才显示（见 roleLabelOf）：
 * 绝大多数通知只有一个时间，给它加个标签只是噪声。
 */
const SCHEDULE_ROLE_LABELS: Record<ScheduleRole, string> = {
  deadline: '截止',
  activity: '活动',
  visit: '到场',
  primary: '主要',
};

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
  /** 用一段新原文重新提炼，只回草稿；官方改口径时用 */
  onReExtract: (id: string, rawText: string) => Promise<ReExtractPreview>;
  onLoadRevisions: (id: string) => Promise<CardRevision[]>;
  onClearRevisions: (id: string) => Promise<void>;
  /** 今天，格式 YYYY-MM-DD；注入是为了测试可确定 */
  today: string;
}

function formatDateLabel(date: string): string {
  const parts = splitIsoDate(date);
  if (!parts) return date;
  const weekday = new Date(parts.year, parts.month - 1, parts.day).getDay();
  // 表头是「一…日」，所以要把 getDay() 的周日=0 换算成周一=0 再查表
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
  onReExtract,
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
  /**
   * 刚点开的那一条日程（`cardId#index`）。
   *
   * 只用来把详情里对应的那一条高亮出来：点的是「活动 宿舍长大会」时，
   * 详情列表里就该立刻看出是哪一条，而不是让人在几条同名卡片里对日期。
   */
  const [activeEntryKey, setActiveEntryKey] = useState<string | null>(null);
  /** 正在展开原文的那一条（`cardId#index`），同一时刻只展开一条 */
  const [showRawKey, setShowRawKey] = useState<string | null>(null);
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

  /**
   * 选中日期当天的安排，**按日程逐条列**，而不是按卡片。
   *
   * 两个理由：
   *   · 一张卡可能有多条日程（截止 + 活动），它们落在不同的日子。
   *     从前只拿主日程去匹配，次要日程那天就"看得见条、点开却没有这条"；
   *   · 同一天可能挤着好几件事，按日程列才能一件一条地列全。
   */
  const selectedEntries = useMemo(() => {
    if (!selectedDate) return [];
    const entries: Array<{ card: CardView; schedule: CardSchedule; scheduleIndex: number; key: string }> = [];
    for (const card of cards) {
      card.schedules.forEach((schedule, scheduleIndex) => {
        if (isDateInSchedule(selectedDate, schedule)) {
          entries.push({ card, schedule, scheduleIndex, key: `${card.id}#${scheduleIndex}` });
        }
      });
    }
    // 先按这天是不是起点排（当天开始的排前面），再按标题稳定排序
    return entries.sort((a, b) => {
      const aStarts = a.schedule.start === selectedDate ? 0 : 1;
      const bStarts = b.schedule.start === selectedDate ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.card.title.localeCompare(b.card.title, 'zh-Hans-CN');
    });
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
    // 每条区间对应卡片上的第几条日程。一条通知可能同时有"截止"与"活动"，
    // 两条都画出来、各自带标签，才分得清哪个是哪个。
    const schedule = span.card.schedules[span.scheduleIndex] ?? span.card.schedule;
    const isMulti = (schedule?.dayCount ?? 1) >= 2;
    /**
     * 标签规则：**一张卡有多条日程时，每条都带标签**（含主日程）。
     *
     * 只有一条日程时不加标签：绝大多数通知就一个时间，
     * 给它挂个「主要」只是噪声。
     */
    const hasSiblings = span.card.schedules.length > 1;
    const roleLabel = hasSiblings ? SCHEDULE_ROLE_LABELS[schedule?.role ?? 'primary'] : null;

    return (
      <button
        key={`${week.days[0]?.date ?? 'w'}-${span.card.id}-${span.scheduleIndex}`}
        type="button"
        className={isMulti ? 'span span--multi' : 'span span--single'}
        data-testid="calendar-span"
        data-card-id={span.card.id}
        data-schedule-index={span.scheduleIndex}
        data-role={schedule?.role ?? 'primary'}
        data-clipped={span.clipped ? 'true' : 'false'}
        style={{
          gridColumn: `${span.startColumn + 1} / ${span.endColumn + 2}`,
          gridRow: span.lane + 2,
          ['--span-color' as string]: color,
          // 墨色也走 CSS 变量：同一个亮度判断在深色主题下要换成另一组墨色
          // （浅色主题下"浅色块用深字"，深色主题下那个深字会糊在暗背景上）
          ['--span-ink' as string]: readableTextColor(color, 'var(--span-ink-dark)', 'var(--span-ink-light)'),
        }}
        title={`${span.card.title}${roleLabel ? `（${roleLabel}）` : ''}：${schedule?.label ?? ''}`}
        onClick={() => {
          // 点区间时优先跳到区间的起始日；跨周延续过来的段则落在本周第一天
          const target = span.startsHere ? (schedule?.start ?? null) : (week.days[0]?.date ?? null);
          setSelectedDate(target);
          // 记住点的是哪一条，详情里把它高亮出来——
          // 同一天可能有好几条，光看标题分不出点的是哪一条
          setActiveEntryKey(`${span.card.id}#${span.scheduleIndex}`);
        }}
      >
        {/* 跑道端头指向的那一天，供读屏理解这条覆盖哪几天 */}
        <span className="visually-hidden">
          {schedule?.start === schedule?.end ? schedule?.start : `${schedule?.start} 至 ${schedule?.end}`}
        </span>
        <span className="span__track" aria-hidden="true" />
        <span className="span__content">
          {roleLabel ? <span className="span__role">{roleLabel}</span> : null}
          <span className="span__label">{span.card.title}</span>
        </span>
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
        <div className="calendar__colors" data-testid="calendar-colors">
          <div className="calendar__colors-head">
            <span className="calendar__colors-title">荧光笔颜色</span>
            <button
              type="button"
              className="calendar__colors-close"
              aria-label="关闭颜色面板"
              onClick={() => setShowColorPanel(false)}
            >
              ×
            </button>
          </div>
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
        className="calendar__grid-row calendar__weekdays"
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
              className="calendar__grid-row calendar__week"
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
          {selectedEntries.length === 0 ? (
            <p className="calendar__detail-empty">这天没有安排。</p>
          ) : (
            <ul className="calendar__detail-list">
              {selectedEntries.map(({ card, schedule, key }) => {
                const isMulti = (schedule?.dayCount ?? 1) >= 2;
                const isFirstDay = schedule?.start === selectedDate;
                const isLastDay = schedule?.end === selectedDate;
                const edited = card.revisionCount > 0;
                // 同一张卡有多条日程时，每条都标出角色，才分得清是哪一件事
                const roleLabel =
                  card.schedules.length > 1 ? SCHEDULE_ROLE_LABELS[schedule?.role ?? 'primary'] : null;

                // 正在改这张卡：整条换成编辑表单，避免"边看边改"时改错对象
                if (editingDetailsId === card.id) {
                  return (
                    <li key={key} className="calendar__detail-item calendar__detail-item--editing">
                      <CardEditForm
                        card={card}
                        onSubmit={async (patch) => {
                          const ok = await onEdit(card.id, patch);
                          if (ok) setEditingDetailsId(null);
                          return ok;
                        }}
                        onReExtract={(rawText) => onReExtract(card.id, rawText)}
                        onCancel={() => setEditingDetailsId(null)}
                      />
                    </li>
                  );
                }

                return (
                  <li
                    key={key}
                    className={
                      activeEntryKey === key
                        ? 'calendar__detail-item calendar__detail-item--active'
                        : 'calendar__detail-item'
                    }
                    data-testid="calendar-detail-item"
                    data-entry-key={key}
                  >
                    <span
                      className="calendar__detail-dot"
                      style={{ background: resolveCardColor(card, styleForRender) }}
                      aria-hidden="true"
                    />
                    <div className="calendar__detail-body">
                      <div className="calendar__detail-name">
                        {roleLabel ? <span className="span__role">{roleLabel}</span> : null}
                        {card.title}
                      </div>
                      <div className="calendar__detail-meta">
                        {schedule?.label ? <span>{schedule.label}</span> : null}
                        {isMulti ? (
                          <span className="calendar__detail-span">
                            共 {schedule?.dayCount} 天
                            {isFirstDay ? '（起始）' : ''}
                            {isLastDay && !isFirstDay ? '（结束）' : ''}
                          </span>
                        ) : null}
                        {edited ? (
                          <span className="calendar__detail-edited" data-testid="detail-edited">
                            已修改 {card.revisionCount} 次
                          </span>
                        ) : null}
                        {schedule?.inferredYear ? (
                          <span className="calendar__detail-inferred">年份为推断所得</span>
                        ) : null}
                      </div>

                      {/*
                        点开一条日程时，这里要能直接看到"这件事到底是什么"。
                        从前只有标题和一句原文片段，还得回卡片列表里翻。
                        现在把来源、时间、要点一并列出；原文按需展开。
                      */}
                      <dl className="calendar__detail-fields">
                        {card.time ? (
                          <>
                            <dt>时间</dt>
                            <dd>{card.time}</dd>
                          </>
                        ) : null}
                        {card.source ? (
                          <>
                            <dt>来源</dt>
                            <dd>{card.source}</dd>
                          </>
                        ) : null}
                      </dl>

                      {card.keyPoints.length > 0 ? (
                        <ul className="calendar__detail-points">
                          {card.keyPoints.map((point, index) => (
                            <li key={`${key}-point-${index}`}>{point}</li>
                          ))}
                        </ul>
                      ) : null}

                      {historyCardId === card.id ? (
                        <RevisionHistory cardId={card.id} load={onLoadRevisions} onClear={onClearRevisions} />
                      ) : null}

                      {showRawKey === key ? <pre className="card__raw">{card.rawText}</pre> : null}
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
                      <button
                        type="button"
                        className="button button--ghost"
                        aria-expanded={showRawKey === key}
                        onClick={() => setShowRawKey((current) => (current === key ? null : key))}
                        aria-label={`查看原文：${card.title}`}
                      >
                        {showRawKey === key ? '收起原文' : '查看原文'}
                      </button>
                      <button
                        type="button"
                        className="button button--ghost"
                        aria-expanded={editingCardId === card.id}
                        onClick={() => setEditingCardId((current) => (current === card.id ? null : card.id))}
                      >
                        {editingCardId === card.id ? '收起颜色' : '改颜色'}
                      </button>
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
                      ) : null}
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
