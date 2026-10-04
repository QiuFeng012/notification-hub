import { useEffect, useRef, useState } from 'react';
import type { CardKeywords, CardRevision, UpdateCardRequest } from '@notification-hub/shared';
import { formatRelative, formatScheduleRange, type CardView } from '../lib/card-view';
import { isExpired } from '../lib/sort';
import { CardEditForm } from './CardEditForm';
import { RevisionHistory } from './RevisionHistory';

interface CardItemProps {
  card: CardView;
  /** 提交修改；返回是否成功 */
  onEdit: (id: string, patch: UpdateCardRequest) => Promise<boolean>;
  onLoadRevisions: (id: string) => Promise<CardRevision[]>;
  onClearRevisions: (id: string) => Promise<void>;
  /** 置顶 / 取消置顶 */
  onTogglePin: (id: string, pinned: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  /** 是否是刚生成的那张卡：滚进视野并闪一下 */
  highlighted?: boolean;
  /** 今天，格式 YYYY-MM-DD */
  today: string;
}

/**
 * 取关键词记录，字段缺失或类型不对时退回空记录。
 *
 * CardView 正常情况下已经归一化过，但组件不能因此假设它一定完好：
 * 一处 undefined 会让整张卡片（乃至整个列表）渲染崩溃，
 * 而这张卡的其他内容本来是能正常显示的。
 */
export function readKeywords(card: Pick<CardView, 'keywords'>): CardKeywords {
  const value = card.keywords as unknown;
  if (typeof value !== 'object' || value === null) {
    return { priority: [], hit: [], missed: [] };
  }
  const record = value as Record<string, unknown>;
  const toList = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : [];
  return {
    priority: toList(record.priority),
    hit: toList(record.hit),
    missed: toList(record.missed),
  };
}

/**
 * 把一段文本按关键词切成片段，命中的片段在界面上用 <mark> 包起来。
 *
 * 注意这里是纯字符串切分，不做正则——关键词来自用户输入，
 * 直接塞进正则会被特殊字符搞坏（甚至造成灾难性回溯）。
 */
export function highlightSegments(
  text: string,
  keywords: string[],
): Array<{ text: string; hit: boolean }> {
  const matched = keywords.filter((keyword) => keyword.length > 0 && text.includes(keyword));
  if (matched.length === 0) return [{ text, hit: false }];

  const segments: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;

  while (cursor < text.length) {
    let nextIndex = -1;
    let nextKeyword = '';
    for (const keyword of matched) {
      const index = text.indexOf(keyword, cursor);
      // 取最近的一次命中；位置相同时取更长的关键词，避免短词盖住长词
      const better =
        index !== -1 &&
        (nextIndex === -1 || index < nextIndex || (index === nextIndex && keyword.length > nextKeyword.length));
      if (better) {
        nextIndex = index;
        nextKeyword = keyword;
      }
    }

    if (nextIndex === -1) {
      segments.push({ text: text.slice(cursor), hit: false });
      break;
    }
    if (nextIndex > cursor) segments.push({ text: text.slice(cursor, nextIndex), hit: false });
    segments.push({ text: text.slice(nextIndex, nextIndex + nextKeyword.length), hit: true });
    cursor = nextIndex + nextKeyword.length;
  }

  return segments.filter((segment) => segment.text.length > 0);
}

/** 兜底要点由服务端补入，前缀是固定标记，界面上单独标注 */
const FALLBACK_PREFIX = '（关注点）';

/** 单张信息卡：标题 + 元信息 + 要点列表，原文默认折叠 */
export function CardItem({
  card,
  onEdit,
  onLoadRevisions,
  onClearRevisions,
  onTogglePin,
  onDelete,
  highlighted = false,
  today,
}: CardItemProps) {
  const [showRaw, setShowRaw] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const articleRef = useRef<HTMLElement>(null);

  const { priority, hit, missed } = readKeywords(card);
  const hasKeywords = priority.length > 0;
  const edited = card.revisionCount > 0;
  const scheduleLabel = formatScheduleRange(card.schedule, Number(today.slice(0, 4)));
  const expired = isExpired(card, today);

  // 列表按事件时间排，新卡片可能落在视野外（没有日期的更是直接沉底），
  // 所以生成之后主动把它滚进视野，否则用户会以为提交失败了。
  useEffect(() => {
    if (!highlighted) return;
    // jsdom 没有实现 scrollIntoView，用可选调用让组件测试也能跑
    articleRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [highlighted]);

  const className = [
    'card',
    card.pinned ? 'card--pinned' : '',
    highlighted ? 'card--new' : '',
  ]
    .filter(Boolean)
    .join(' ');

  if (editing) {
    return (
      <article className={className} ref={articleRef} data-testid="info-card" data-card-id={card.id}>
        <header className="card__header">
          <h3 className="card__title">修改信息卡</h3>
        </header>
        <CardEditForm
          card={card}
          onSubmit={async (patch) => {
            const ok = await onEdit(card.id, patch);
            if (ok) setEditing(false);
            return ok;
          }}
          onCancel={() => setEditing(false)}
        />
      </article>
    );
  }

  return (
    <article className={className} ref={articleRef} data-testid="info-card" data-card-id={card.id}>
      <header className="card__header">
        <h3 className="card__title">{card.title}</h3>
        <span className="card__time-ago" title={card.createdAtLabel}>
          {formatRelative(card.createdAt)}
        </span>
      </header>

      <div className="card__meta">
        {card.pinned ? (
          <span className="chip chip--pinned" data-testid="pinned-badge">
            已置顶
          </span>
        ) : null}
        <span className="chip">
          <span className="chip__key">来源</span>
          {card.source ?? '未识别'}
        </span>
        <span className="chip">
          <span className="chip__key">时间</span>
          {card.time ?? '未识别'}
        </span>
        {scheduleLabel ? (
          <span className="chip chip--schedule" data-testid="schedule-chip" title="列表按这个日期排序">
            <span className="chip__key">日程</span>
            {scheduleLabel}
          </span>
        ) : (
          <span className="chip chip--no-schedule" data-testid="no-schedule-chip">
            无日期
          </span>
        )}
        {expired ? (
          <span className="chip chip--expired" data-testid="expired-chip" title="已过期的卡片排在下面">
            已过期
          </span>
        ) : null}
        <span className={card.provider === 'deepseek' ? 'chip chip--ai' : 'chip chip--mock'}>
          {card.provider === 'deepseek' ? 'AI 摘要' : '启发式摘要'}
        </span>
        {edited ? (
          <span
            className="chip chip--edited"
            data-testid="edited-badge"
            title={card.updatedAt ? `最后修改于 ${card.updatedAt}` : undefined}
          >
            已修改 {card.revisionCount} 次
          </span>
        ) : null}
        {hit.length > 0 ? (
          <span className="chip chip--keyword" data-testid="keyword-hit">
            含你关注的：{hit.join('、')}
          </span>
        ) : null}
      </div>

      {hasKeywords ? (
        <p className="card__keywords">
          本次关注点：{priority.join('、')}
          {missed.length > 0 ? (
            <span className="card__keywords-missed">
              （{missed.join('、')} 由系统从原文补入，AI 未覆盖）
            </span>
          ) : null}
        </p>
      ) : null}

      {card.keyPoints.length > 0 ? (
        <ul className="card__points">
          {card.keyPoints.map((point, index) => {
            const isFallback = point.startsWith(FALLBACK_PREFIX);
            return (
              <li
                key={`${card.id}-${index}`}
                className={isFallback ? 'card__point card__point--fallback' : 'card__point'}
              >
                {highlightSegments(point, priority).map((segment, segmentIndex) =>
                  segment.hit ? (
                    <mark key={segmentIndex} className="keyword-mark">
                      {segment.text}
                    </mark>
                  ) : (
                    <span key={segmentIndex}>{segment.text}</span>
                  ),
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="card__empty">这条通知没有提炼出要点。</p>
      )}

      <footer className="card__footer">
        <button
          type="button"
          className={card.pinned ? 'button button--ghost button--pin-on' : 'button button--ghost'}
          aria-pressed={card.pinned}
          onClick={() => void onTogglePin(card.id, !card.pinned)}
          aria-label={`${card.pinned ? '取消置顶' : '置顶'}信息卡：${card.title}`}
        >
          {card.pinned ? '取消置顶' : '置顶'}
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => setEditing(true)}
          aria-label={`修改信息卡：${card.title}`}
        >
          修改
        </button>
        {edited ? (
          <button
            type="button"
            className="button button--ghost"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((value) => !value)}
          >
            {showHistory ? '收起改动历史' : '改动历史'}
          </button>
        ) : null}
        <button type="button" className="button button--ghost" onClick={() => setShowRaw((value) => !value)}>
          {showRaw ? '收起原文' : '查看原文'}
        </button>
        <button
          type="button"
          className="button button--danger"
          onClick={() => void onDelete(card.id)}
          aria-label={`删除信息卡：${card.title}`}
        >
          删除
        </button>
      </footer>

      {showHistory ? (
        <RevisionHistory cardId={card.id} load={onLoadRevisions} onClear={onClearRevisions} />
      ) : null}
      {showRaw ? <pre className="card__raw">{card.rawText}</pre> : null}
    </article>
  );
}
