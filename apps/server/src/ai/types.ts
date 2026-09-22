import type { SummaryProvider } from '@notification-hub/shared';

/**
 * AI 生成的信息卡草稿：id 与 createdAt 由服务端负责，模型无权决定。
 */
export interface CardDraft {
  title: string;
  time: string | null;
  source: string | null;
  keyPoints: string[];
}

/** 摘要结果 = 草稿 + 实际产出者 */
export interface SummaryResult {
  draft: CardDraft;
  provider: SummaryProvider;
}

/** 摘要器：把通知原文提炼成信息卡草稿 */
export interface Summarizer {
  summarize(rawText: string): Promise<SummaryResult>;
}

/** 模型输出无法解析时抛出，由上层转成 502 并附上可读原因 */
export class SummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SummaryError';
  }
}

/** 要点数量上限：卡片是给人看的，超过 6 条就不叫"要点"了 */
export const MAX_KEY_POINTS = 6;
/** 单条要点长度上限 */
export const MAX_KEY_POINT_LENGTH = 120;
/** 标题长度上限 */
export const MAX_TITLE_LENGTH = 60;
