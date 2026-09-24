import { useState } from 'react';
import type { CardKeywords } from '@notification-hub/shared';
import { formatRelative, type CardView } from '../lib/card-view';

interface CardItemProps {
  card: CardView;
  onDelete: (id: string) => Promise<void>;
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
export function CardItem({ card, onDelete }: CardItemProps) {
  const [showRaw, setShowRaw] = useState(false);

  const { priority, hit, missed } = readKeywords(card);
  const hasKeywords = priority.length > 0;

  return (
    <article className="card" data-testid="info-card">
      <header className="card__header">
        <h3 className="card__title">{card.title}</h3>
        <span className="card__time-ago" title={card.createdAtLabel}>
          {formatRelative(card.createdAt)}
        </span>
      </header>

      <div className="card__meta">
        <span className="chip">
          <span className="chip__key">来源</span>
          {card.source ?? '未识别'}
        </span>
        <span className="chip">
          <span className="chip__key">时间</span>
          {card.time ?? '未识别'}
        </span>
        <span className={card.provider === 'deepseek' ? 'chip chip--ai' : 'chip chip--mock'}>
          {card.provider === 'deepseek' ? 'AI 摘要' : '启发式摘要'}
        </span>
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

      {showRaw ? <pre className="card__raw">{card.rawText}</pre> : null}
    </article>
  );
}
