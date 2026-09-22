/**
 * 信息卡：本项目的核心数据结构。
 *
 * 设计原则：字段固定，AI 只负责填值，不负责决定结构。
 * 这样"AI 总结"和"卡片渲染"彻底解耦，卡片样式不会随模型输出漂移。
 */
export interface InfoCard {
  /** 主键，服务端生成的 UUID */
  id: string;
  /** 通知标题：AI 概括，或从原文提取的关键主题 */
  title: string;
  /** 通知相关时间：原文能识别出就填，识别不出留 null（前端显示"未识别"） */
  time: string | null;
  /** 来源：如某群、某平台、某机构；识别不出留 null */
  source: string | null;
  /** 要点列表：卡片的正文主体，按重要性排序 */
  keyPoints: string[];
  /** 原始通知原文，一并存档，便于核对 AI 是否漏信息 */
  rawText: string;
  /** 摘要由谁生成：'deepseek' 为真实模型，'mock' 为未配置 Key 时的本地回退 */
  provider: SummaryProvider;
  /** 创建时间，ISO 8601 字符串 */
  createdAt: string;
}

export type SummaryProvider = 'deepseek' | 'mock';

/** POST /api/cards 的请求体 */
export interface CreateCardRequest {
  /** 用户粘贴的通知原文 */
  rawText: string;
}

/** 信息卡列表响应 */
export interface CardListResponse {
  cards: InfoCard[];
  total: number;
}

/** 统一的错误响应结构 */
export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

/** 输入长度上限，避免误粘贴超长内容把 token 烧穿 */
export const MAX_RAW_TEXT_LENGTH = 8000;
