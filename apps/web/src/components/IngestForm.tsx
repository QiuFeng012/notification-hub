import { useRef, useState } from 'react';
import { MAX_KEYWORDS, MAX_KEYWORD_LENGTH, MAX_RAW_TEXT_LENGTH } from '@notification-hub/shared';

const PLACEHOLDER = `把收到的通知原文粘贴到这里，例如：

【教务处】各位同学：本学期选课将于3月5日14:00开放，
请于3月8日24:00前在教务系统完成选课，逾期系统自动关闭。`;

/**
 * 把输入框里的字符串拆成关键词。
 * 与共享包里的 normalizeKeywords 保持同样的分隔符规则，
 * 但这里额外做长度裁剪，让人边打边能看到结果。
 */
export function parseKeywordInput(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const piece of value.split(/[,，、;；]+/)) {
    const keyword = piece.trim().slice(0, MAX_KEYWORD_LENGTH);
    if (keyword.length === 0) continue;
    const fingerprint = keyword.toLowerCase();
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    result.push(keyword);
  }
  return result;
}

interface IngestFormProps {
  submitting: boolean;
  onSubmit: (rawText: string, keywords?: string[]) => Promise<boolean>;
}

/**
 * 输入栏：整个应用唯一的入口。
 * 提交成功后清空并聚焦，方便连续处理多条通知。
 *
 * 「本次关注点」是一次性的：只影响这一次生成，生成后立即清空，
 * 所以它不会被误当成需要长期维护的配置。
 */
export function IngestForm({ submitting, onSubmit }: IngestFormProps) {
  const [rawText, setRawText] = useState('');
  const [keywordInput, setKeywordInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const trimmedLength = rawText.trim().length;
  const tooLong = trimmedLength > MAX_RAW_TEXT_LENGTH;

  const keywords = parseKeywordInput(keywordInput);
  const tooManyKeywords = keywords.length > MAX_KEYWORDS;

  const canSubmit = trimmedLength > 0 && !tooLong && !tooManyKeywords && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    const succeeded = await onSubmit(rawText, keywords);
    if (succeeded) {
      setRawText('');
      setKeywordInput('');
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

      <label className="ingest__label" htmlFor="keyword-input">
        本次关注点
        <span className="ingest__label-note">可选</span>
      </label>
      <input
        id="keyword-input"
        className="ingest__keywords"
        type="text"
        value={keywordInput}
        placeholder="面试、报销、3 号楼（用逗号分隔，只影响这一次）"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setKeywordInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void handleSubmit();
          }
        }}
      />

      {keywords.length > 0 || tooManyKeywords ? (
        <div className="ingest__keyword-list">
          {keywords.map((keyword) => (
            <span key={keyword} className="keyword-pill">
              {keyword}
            </span>
          ))}
          {tooManyKeywords ? (
            <span className="ingest__keyword-error">
              最多 {MAX_KEYWORDS} 个，当前 {keywords.length} 个
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="ingest__footer">
        <span className={tooLong ? 'ingest__count ingest__count--over' : 'ingest__count'}>
          {trimmedLength} / {MAX_RAW_TEXT_LENGTH}
        </span>
        <button type="submit" className="button button--primary" disabled={!canSubmit}>
          {submitting ? '正在总结…' : '生成信息卡'}
        </button>
      </div>

      <p className="ingest__hint">
        填了关注点，AI 会优先覆盖它们；万一漏了，服务端会从原文里补出证据句。
        关注点只用于这一次生成，不会被保存成长期配置。
      </p>
    </form>
  );
}
