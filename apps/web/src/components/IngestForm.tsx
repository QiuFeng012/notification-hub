import { useRef, useState } from 'react';
import { MAX_RAW_TEXT_LENGTH } from '@notification-hub/shared';

const PLACEHOLDER = `把收到的通知原文粘贴到这里，例如：

【教务处】各位同学：本学期选课将于3月5日14:00开放，
请于3月8日24:00前在教务系统完成选课，逾期系统自动关闭。`;

interface IngestFormProps {
  submitting: boolean;
  onSubmit: (rawText: string) => Promise<boolean>;
}

/**
 * 输入栏：整个应用唯一的入口。
 * 提交成功后自动清空并聚焦，方便连续处理多条通知。
 */
export function IngestForm({ submitting, onSubmit }: IngestFormProps) {
  const [rawText, setRawText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const trimmedLength = rawText.trim().length;
  const tooLong = trimmedLength > MAX_RAW_TEXT_LENGTH;
  const canSubmit = trimmedLength > 0 && !tooLong && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    const succeeded = await onSubmit(rawText);
    if (succeeded) {
      setRawText('');
      textareaRef.current?.focus();
    }
  }

  return (
    <form
      className="ingest"
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
    >
      <label className="ingest__label" htmlFor="raw-text">
        通知原文
      </label>
      <textarea
        id="raw-text"
        ref={textareaRef}
        className="ingest__textarea"
        value={rawText}
        placeholder={PLACEHOLDER}
        spellCheck={false}
        autoFocus
        onChange={(event) => setRawText(event.target.value)}
        onKeyDown={(event) => {
          // Ctrl/Cmd + Enter 快速提交，普通 Enter 仍然换行
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            void handleSubmit();
          }
        }}
      />

      <div className="ingest__footer">
        <span className={tooLong ? 'ingest__count ingest__count--over' : 'ingest__count'}>
          {trimmedLength} / {MAX_RAW_TEXT_LENGTH}
        </span>
        <button type="submit" className="button button--primary" disabled={!canSubmit}>
          {submitting ? '正在总结…' : '生成信息卡'}
        </button>
      </div>

      <p className="ingest__hint">提示：Ctrl + Enter 可直接提交；生成的信息卡会保存在本机数据库。</p>
    </form>
  );
}
