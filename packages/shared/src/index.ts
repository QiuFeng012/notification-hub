/**
 * 关键词命中情况：这张卡是否覆盖了用户当次填写的关注点。
 *
 * 服务端会在摘要之后做一次确定性校验：原文里出现了某个关键词，
 * 但要点里一条都没覆盖到，就补一条兜底要点进来。
 * 这样"AI 漏掉你在意的信息"从"看模型心情"变成可断言的保证。
 */
export interface CardKeywords {
  /** 生成这张卡时用户填写的关注点 */
  priority: string[];
  /** 确实出现在要点里的关键词 */
  hit: string[];
  /** 原文提到了、但要点里没覆盖、由服务端兜底补入的关键词 */
  missed: string[];
}

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
  /**
   * 生成时的关注点记录。存的是"我当时在关注什么"，不是长期配置，
   * 所以日后回看能知道这条卡为什么是现在这个样子。
   */
  keywords: CardKeywords;
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
  /**
   * 本次生成要重点关注的词，如 ["面试", "报销", "3 号楼"]。
   * 一次性使用：只影响本次生成的这一张卡，不进入任何长期配置。
   */
  keywords?: string[];
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

/**
 * 单张卡最多几个关注点关键词。
 * 上限存在的意义不是技术限制，是逼用户取舍：
 * 20 个以上的"关注点"等于没有关注点。
 */
export const MAX_KEYWORDS = 20;
/** 单个关键词长度上限 */
export const MAX_KEYWORD_LENGTH = 30;

/** 关键词去重与裁剪：中英文标点、空白都当分隔符 */
export function normalizeKeywords(input: unknown): string[] {
  const list = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,，、;；\s]+/)
      : [];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const keyword = item.trim().slice(0, MAX_KEYWORD_LENGTH);
    if (keyword.length === 0) continue;
    // 大小写不敏感去重，但保留用户输入的原样用于展示
    const fingerprint = keyword.toLowerCase();
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    result.push(keyword);
    if (result.length >= MAX_KEYWORDS) break;
  }
  return result;
}

/** 某段文本是否提到了这个关键词（大小写不敏感） */
export function textMentionsKeyword(text: string, keyword: string): boolean {
  if (keyword.length === 0) return false;
  return text.toLowerCase().includes(keyword.toLowerCase());
}

/** API Key 长度上限，防止误粘贴整段文本 */
export const MAX_API_KEY_LENGTH = 200;
/** base URL 长度上限 */
export const MAX_BASE_URL_LENGTH = 300;
/** 模型名长度上限 */
export const MAX_MODEL_LENGTH = 100;

/** 当前生效的摘要来源 */
export type SettingsSource =
  /** 用户在界面上填写的 Key（存在 data/settings.json） */
  | 'user'
  /** 来自环境变量 / .env 的 Key */
  | 'env'
  /** 没有 Key，使用本地启发式摘要 */
  | 'mock';

/**
 * 设置视图。**永远不包含完整 Key**，只回显掩码，
 * 避免密钥经由接口或浏览器缓存泄漏。
 */
export interface SettingsView {
  /** 是否已配置可用的 API Key */
  configured: boolean;
  /** Key 掩码，如 "sk-1234…cdef"；未配置为 null */
  apiKeyMask: string | null;
  source: SettingsSource;
  /** 生效的 base URL */
  baseUrl: string;
  /** 生效的模型名 */
  model: string;
}

/** PUT /api/settings 的请求体：只传要改的字段，未传的保持不变 */
export interface UpdateSettingsRequest {
  /** 新的 API Key；空字符串表示清除已保存的 Key */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** PUT /api/settings 的响应：保存后的设置，加上一条可选提示 */
export interface UpdateSettingsResponse {
  settings: SettingsView;
  /**
   * 非致命提示。Key 校验遇到网络问题、限流等无法判定真伪的情况时，
   * 仍然保存，但把原因告诉用户，而不是假装一切正常。
   */
  warning: string | null;
}

