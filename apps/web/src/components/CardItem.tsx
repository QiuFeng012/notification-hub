import { useState } from 'react';
import { formatRelative, type CardView } from '../lib/card-view';

interface CardItemProps {
  card: CardView;
  onDelete: (id: string) => Promise<void>;
}

/** 单张信息卡：标题 + 元信息 + 要点列表，原文默认折叠 */
export function CardItem({ card, onDelete }: CardItemProps) {
  const [showRaw, setShowRaw] = useState(false);

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
      </div>

      {card.keyPoints.length > 0 ? (
        <ul className="card__points">
          {card.keyPoints.map((point, index) => (
            <li key={`${card.id}-${index}`}>{point}</li>
          ))}
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
