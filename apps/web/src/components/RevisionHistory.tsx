import { useEffect, useState } from 'react';
import { REVISION_REASON_LABELS, type CardRevision } from '@notification-hub/shared';
import { formatTimestamp } from '../lib/card-view';

interface RevisionHistoryProps {
  cardId: string;
  /** 拉取历史；由调用方注入，便于测试 */
  load: (id: string) => Promise<CardRevision[]>;
  /** 清空历史；不传则不显示清空入口 */
  onClear?: (id: string) => Promise<void>;
}

/**
 * 改动历史。
 *
 * 每条记录的是"改动**前**的内容"，所以读法就是：
 * 因为「官方通知更新」，把下面的内容改成了现在这样。
 * 这个方向的叙述比"改成了什么"更有用——用户想确认的通常是
 * "原来的截止时间到底是几号"。
 */
export function RevisionHistory({ cardId, load, onClear }: RevisionHistoryProps) {
  const [revisions, setRevisions] = useState<CardRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await load(cardId);
        if (!cancelled) setRevisions(list);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : '读取改动历史失败');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cardId, load]);

  async function handleClear() {
    if (!onClear) return;
    setClearing(true);
    try {
      await onClear(cardId);
      setRevisions([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '清空失败');
    } finally {
      setClearing(false);
    }
  }

  if (error) return <p className="revisions__error">{error}</p>;
  if (revisions === null) return <p className="revisions__loading">正在读取改动历史…</p>;
  if (revisions.length === 0) {
    return <p className="revisions__empty">这条还没被改过。</p>;
  }

  return (
    <div>
      <ol className="revisions" data-testid="revision-history">
        {revisions.map((revision) => (
          <li key={revision.id} className="revisions__item">
            <div className="revisions__head">
              <span className="revisions__reason">{REVISION_REASON_LABELS[revision.reason]}</span>
              <span className="revisions__time">{formatTimestamp(revision.createdAt)}</span>
            </div>
            {revision.note ? <p className="revisions__note">{revision.note}</p> : null}
            <dl className="revisions__fields">
              <dt>原标题</dt>
              <dd>{revision.previousTitle || '（空）'}</dd>
              <dt>原时间</dt>
              <dd>{revision.previousTime ?? '未识别'}</dd>
              <dt>原来源</dt>
              <dd>{revision.previousSource ?? '未识别'}</dd>
              <dt>原要点</dt>
              <dd>
                {revision.previousKeyPoints.length === 0 ? (
                  '（无）'
                ) : (
                  <ul className="revisions__points">
                    {revision.previousKeyPoints.map((point, index) => (
                      <li key={`${revision.id}-${index}`}>{point}</li>
                    ))}
                  </ul>
                )}
              </dd>
            </dl>
          </li>
        ))}
      </ol>

      {onClear ? (
        <button
          type="button"
          className="button button--danger revisions__clear"
          disabled={clearing}
          onClick={() => void handleClear()}
        >
          {clearing ? '正在清空…' : '清空改动历史'}
        </button>
      ) : null}
    </div>
  );
}
