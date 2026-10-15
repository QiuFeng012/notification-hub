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
  type ReExtractPreview,
  type RevisionReason,
  type UpdateCardRequest,
} from '@notification-hub/shared';
import { formatScheduleRange, type CardView } from '../lib/card-view';

export interface CardEditFormProps {
  card: CardView;
  onSubmit: (patch: UpdateCardRequest) => Promise<boolean>;
  onCancel: () => void;
  /**
   * 用一段新原文重新提炼，返回草稿供逐项对比。
   * 由上层注入，组件自己不直接发请求——它的测试因此不需要起服务。
   */
  onReExtract: (rawText: string) => Promise<ReExtractPreview>;
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
 *   - 时间改动会由服务端重新解析排期（而且每次保存都会重算），
 *     所以这里只需要如实填写时间文本。
 *
 * 官方改口径时不必手抄：把修改后的原文粘进上面的框，重新提炼一遍，
 * 逐项对比后再决定采纳哪几项。**刻意不做成自动覆盖**——官方改动未必只动时间，
 * 而用户可能手工订正过要点，冲掉之后再想找回来只能翻改动历史。
 */
export function CardEditForm({ card, onSubmit, onCancel, onReExtract }: CardEditFormProps) {
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

  // 重新提炼：粘贴的原文 + 提炼结果。draft 非空时展示逐项对比。
  const [pastedText, setPastedText] = useState('');
  const [draft, setDraft] = useState<ReExtractPreview | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

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

  async function handleReExtract() {
    const text = pastedText.trim();
    if (text.length === 0) {
      setExtractError('先把官方修改后的原文粘进来');
      return;
    }
    setExtracting(true);
    setExtractError(null);
    try {
      setDraft(await onReExtract(text));
      // 官方改了口径，原因默认就该是"官方通知更新"；用户仍可改
      setReason('official');
    } catch (error) {
      setDraft(null);
      setExtractError(error instanceof Error ? error.message : '重新提炼失败');
    } finally {
      setExtracting(false);
    }
  }

  /** 采纳某一项。只动被点的那一项，其余保持用户当前编辑的内容 */
  function apply(field: 'title' | 'time' | 'source' | 'keyPoints') {
    if (!draft) return;
    if (field === 'title') setTitle(draft.title);
    if (field === 'time') setTime(draft.time ?? '');
    if (field === 'source') setSource(draft.source ?? '');
    if (field === 'keyPoints') {
      setKeyPoints(draft.keyPoints.length > 0 ? [...draft.keyPoints] : ['']);
    }
  }

  function applyAll() {
    if (!draft) return;
    setTitle(draft.title);
    setTime(draft.time ?? '');
    setSource(draft.source ?? '');
    setKeyPoints(draft.keyPoints.length > 0 ? [...draft.keyPoints] : ['']);
    // 把原文留一段在"补充说明"里，日后对账时知道这轮改的是哪份通知
    setNote(draft.rawText.slice(0, EDIT_MAX_NOTE_LENGTH));
  }

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
      {/* 官方改口径的入口。放在最前面：用户点「修改」多半就是遇到了这种情况 */}
      <section className="re-extract" aria-label="按官方修改后的原文重新提炼">
        <h4 className="re-extract__title">官方改了口径？粘进来重新提炼</h4>
        <p className="re-extract__desc">
          把修改后的通知原文粘到下面，重新提炼标题、时间与要点。
          <strong>不会直接覆盖</strong>——提炼结果会与当前内容逐项对比，你自己决定采纳哪几项。
        </p>
        <textarea
          className="re-extract__input"
          aria-label="官方修改后的原文"
          placeholder="粘贴官方修改后的通知原文…"
          value={pastedText}
          onChange={(event) => setPastedText(event.target.value)}
        />
        <div className="re-extract__actions">
          <button
            type="button"
            className="button button--ghost"
            disabled={extracting}
            onClick={() => void handleReExtract()}
          >
            {extracting ? '正在重新提炼…' : '重新提炼'}
          </button>
          {draft ? (
            <button type="button" className="button button--ghost" onClick={applyAll}>
              全部采纳
            </button>
          ) : null}
        </div>

        {extractError ? <p className="edit-form__error">{extractError}</p> : null}

        {draft ? (
          <div className="re-extract__diff" data-testid="re-extract-diff">
            <div className="re-extract__row">
              <span className="re-extract__field">标题</span>
              <span className="re-extract__old">{title}</span>
              <span className="re-extract__new">{draft.title}</span>
              <button type="button" className="button button--ghost" onClick={() => apply('title')}>
                采纳
              </button>
            </div>

            <div className="re-extract__row">
              <span className="re-extract__field">时间</span>
              <span className="re-extract__old">{time.trim().length > 0 ? time : '（空）'}</span>
              <span className={draft.time ? 're-extract__new' : 're-extract__new re-extract__new--empty'}>
                {draft.time ?? '（没识别出时间）'}
              </span>
              <button type="button" className="button button--ghost" onClick={() => apply('time')}>
                采纳
              </button>
            </div>

            <div className="re-extract__row">
              <span className="re-extract__field">来源</span>
              <span className="re-extract__old">{source.trim().length > 0 ? source : '（空）'}</span>
              <span className={draft.source ? 're-extract__new' : 're-extract__new re-extract__new--empty'}>
                {draft.source ?? '（没识别出来源）'}
              </span>
              <button type="button" className="button button--ghost" onClick={() => apply('source')}>
                采纳
              </button>
            </div>

            <div className="re-extract__row">
              <span className="re-extract__field">要点</span>
              <span className="re-extract__old">{keyPoints.filter((p) => p.trim()).length} 条</span>
              <span className="re-extract__new">
                {draft.keyPoints.length} 条
                <ul className="re-extract__points">
                  {draft.keyPoints.map((point) => (
                    <li key={point}>{point}</li>
                  ))}
                </ul>
              </span>
              <button type="button" className="button button--ghost" onClick={() => apply('keyPoints')}>
                采纳
              </button>
            </div>

            <p className="re-extract__note">
              排期：{formatScheduleRange(draft.schedule, new Date().getFullYear()) ?? '没识别出日期，这张卡不会进日历'}
              {draft.schedule?.inferredYear ? '（年份为推断所得）' : ''}
            </p>
            {draft.supplementedKeywords.length > 0 ? (
              <p className="re-extract__note">
                替你补了关注的：{draft.supplementedKeywords.join('、')}
              </p>
            ) : null}
            <p className="re-extract__note">
              这次由{draft.provider === 'deepseek' ? '真实模型' : '本地启发式摘要器'}提炼。
              采纳之后还要点最下方的「保存修改」才会写入。
            </p>
          </div>
        ) : null}
      </section>

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
