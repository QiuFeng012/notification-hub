import { useState } from 'react';
import {
  EDIT_MAX_KEY_POINTS,
  EDIT_MAX_KEY_POINT_LENGTH,
  EDIT_MAX_NOTE_LENGTH,
  EDIT_MAX_SOURCE_LENGTH,
  EDIT_MAX_TIME_LENGTH,
  EDIT_MAX_TITLE_LENGTH,
  REVISION_REASON_LABELS,
  REVISION_REASONS,
  type RevisionReason,
  type UpdateCardRequest,
} from '@notification-hub/shared';
import type { CardView } from '../lib/card-view';

export interface CardEditFormProps {
  card: CardView;
  onSubmit: (patch: UpdateCardRequest) => Promise<boolean>;
  onCancel: () => void;
}

/**
 * 编辑信息卡的表单。
 *
 * 存在的理由：官方通知经常改口径（截止时间推迟、地点变更），
 * 这时用户需要把卡片改成"现在正确"的样子，而不是重新粘贴一遍。
 *
 * 两个刻意的约束：
 *   - **修改原因必填**。没有它，日后看到这条与原文不一致时无法解释，
 *     也就无法判断该以哪个为准。
 *   - 时间改动会由服务端重新解析排期，所以这里只需要如实填写时间文本。
 */
export function CardEditForm({ card, onSubmit, onCancel }: CardEditFormProps) {
  const [title, setTitle] = useState(card.title);
  const [time, setTime] = useState(card.time ?? '');
  const [source, setSource] = useState(card.source ?? '');
  const [keyPoints, setKeyPoints] = useState<string[]>(
    card.keyPoints.length > 0 ? [...card.keyPoints] : [''],
  );
  const [reason, setReason] = useState<RevisionReason>('official');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const titleError = title.trim().length === 0 ? '标题不能为空' : null;
  const titleTooLong = title.trim().length > EDIT_MAX_TITLE_LENGTH ? `标题最多 ${EDIT_MAX_TITLE_LENGTH} 字` : null;
  const meaningfulPoints = keyPoints.filter((point) => point.trim().length > 0);
  const pointsError = meaningfulPoints.length === 0 ? '至少要保留一条要点' : null;
  const pointsTooMany = meaningfulPoints.length > EDIT_MAX_KEY_POINTS
    ? `要点最多 ${EDIT_MAX_KEY_POINTS} 条，当前 ${meaningfulPoints.length} 条`
    : null;
  const pointTooLong = meaningfulPoints.some((point) => point.trim().length > EDIT_MAX_KEY_POINT_LENGTH)
    ? `单条要点最多 ${EDIT_MAX_KEY_POINT_LENGTH} 字`
    : null;

  const blockError = titleError ?? titleTooLong ?? pointsError ?? pointsTooMany ?? pointTooLong;
  const canSubmit = !blockError && !saving;

  function updatePoint(index: number, value: string) {
    setKeyPoints((previous) => previous.map((point, i) => (i === index ? value : point)));
  }

  function addPoint() {
    setKeyPoints((previous) =>
      previous.length >= EDIT_MAX_KEY_POINTS ? previous : [...previous, ''],
    );
  }

  function removePoint(index: number) {
    setKeyPoints((previous) =>
      previous.length <= 1 ? previous : previous.filter((_, i) => i !== index),
    );
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSaving(true);
    setLocalError(null);

    const patch: UpdateCardRequest = {
      title: title.trim(),
      // 空字符串等于清空；服务端会把它当成 null
      time: time.trim().length > 0 ? time.trim() : null,
      source: source.trim().length > 0 ? source.trim() : null,
      keyPoints: meaningfulPoints.map((point) => point.trim()),
      reason,
      ...(note.trim().length > 0 ? { note: note.trim() } : {}),
    };

    const ok = await onSubmit(patch);
    setSaving(false);
    if (!ok) setLocalError('保存失败，请查看上方提示');
  }

  return (
    <form
      className="edit-form"
      data-testid="card-edit-form"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <label className="edit-form__label" htmlFor="edit-title">
        标题
      </label>
      <input
        id="edit-title"
        className="edit-form__input"
        value={title}
        maxLength={EDIT_MAX_TITLE_LENGTH + 10}
        onChange={(event) => setTitle(event.target.value)}
      />

      <div className="edit-form__row">
        <span>
          <label className="edit-form__label" htmlFor="edit-time">
            时间
          </label>
          <input
            id="edit-time"
            className="edit-form__input"
            value={time}
            placeholder="例如 2026年10月5日"
            maxLength={EDIT_MAX_TIME_LENGTH + 10}
            onChange={(event) => setTime(event.target.value)}
          />
        </span>
        <span>
          <label className="edit-form__label" htmlFor="edit-source">
            来源
          </label>
          <input
            id="edit-source"
            className="edit-form__input"
            value={source}
            maxLength={EDIT_MAX_SOURCE_LENGTH + 10}
            onChange={(event) => setSource(event.target.value)}
          />
        </span>
      </div>
      <p className="edit-form__hint">
        改了时间，日历上的位置会跟着重排；留空表示这条没有可排的日期。
      </p>

      <span className="edit-form__label">要点</span>
      <div className="edit-form__points">
        {keyPoints.map((point, index) => (
          <div key={`point-${index}`} className="edit-form__point">
            <input
              className="edit-form__input"
              value={point}
              aria-label={`要点 ${index + 1}`}
              maxLength={EDIT_MAX_KEY_POINT_LENGTH + 10}
              onChange={(event) => updatePoint(index, event.target.value)}
            />
            <button
              type="button"
              className="button button--danger"
              aria-label={`删除要点 ${index + 1}`}
              disabled={keyPoints.length <= 1}
              onClick={() => removePoint(index)}
            >
              删除
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button button--ghost"
          disabled={keyPoints.length >= EDIT_MAX_KEY_POINTS}
          onClick={addPoint}
        >
          加一条要点
        </button>
      </div>

      <label className="edit-form__label" htmlFor="edit-reason">
        修改原因（必填）
      </label>
      <select
        id="edit-reason"
        className="edit-form__input"
        value={reason}
        onChange={(event) => setReason(event.target.value as RevisionReason)}
      >
        {REVISION_REASONS.map((value) => (
          <option key={value} value={value}>
            {REVISION_REASON_LABELS[value]}
          </option>
        ))}
      </select>

      <label className="edit-form__label" htmlFor="edit-note">
        补充说明
      </label>
      <input
        id="edit-note"
        className="edit-form__input"
        value={note}
        placeholder="例如：教务处把截止时间推迟了一周"
        maxLength={EDIT_MAX_NOTE_LENGTH}
        onChange={(event) => setNote(event.target.value)}
      />

      {blockError ? <p className="edit-form__error">{blockError}</p> : null}
      {localError ? <p className="edit-form__error">{localError}</p> : null}

      <div className="edit-form__actions">
        <button type="submit" className="button button--primary" disabled={!canSubmit}>
          {saving ? '正在保存…' : '保存修改'}
        </button>
        <button type="button" className="button button--ghost" onClick={onCancel} disabled={saving}>
          取消
        </button>
      </div>
    </form>
  );
}
