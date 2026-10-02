import { randomUUID } from 'node:crypto';
import {
  EDIT_MAX_KEY_POINTS,
  EDIT_MAX_KEY_POINT_LENGTH,
  EDIT_MAX_NOTE_LENGTH,
  EDIT_MAX_SOURCE_LENGTH,
  EDIT_MAX_TIME_LENGTH,
  EDIT_MAX_TITLE_LENGTH,
  MAX_RAW_TEXT_LENGTH,
  isRevisionReason,
  normalizeKeywords,
  type CardKeywords,
  type CardRevision,
  type InfoCard,
} from '@notification-hub/shared';
import type { Summarizer } from '../ai/types.js';
import type { SummarizerProvider } from '../ai/provider.js';
import type { CardRepository } from '../db/repository.js';
import { enforceKeywords } from '../keywords/keyword-check.js';
import { parseSchedule } from '../calendar/date-parser.js';

/** 业务规则被违反时抛出，由 HTTP 层映射成 4xx */
export class ValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

export interface CreateCardInput {
  rawText: unknown;
  /** 本次要重点关注的词；未传或非法时按"没有关注点"处理 */
  keywords?: unknown;
}

export interface CardService {
  createCard(input: CreateCardInput): Promise<InfoCard>;
  listCards(): { cards: InfoCard[]; total: number };
  /** 按 id 取一张卡；不存在返回 null */
  getCard(id: string): InfoCard | null;
  /** 编辑一张信息卡；目标不存在返回 null */
  updateCard(id: string, input: unknown): InfoCard | null;
  /** 某张卡片的改动历史 */
  listRevisions(id: string): CardRevision[];
  /** 清空某张卡片的改动历史；目标不存在返回 null */
  clearRevisions(id: string): number | null;
  /** 删除并返回被删掉的信息卡，目标不存在返回 null */
  deleteCard(id: string): InfoCard | null;
}

/** UUID v4：只接受服务端自己生成过的 id 形态，避免把任意字符串丢进 SQL */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 校验 id 形态，顺便挡住把任意字符串丢进 SQL 的可能 */
function assertCardId(id: string): void {
  if (!UUID_PATTERN.test(id)) {
    throw new ValidationError('INVALID_ID', `信息卡 ID 格式不正确：${id}`);
  }
}

/** 可空的文本字段：允许显式传 null 表示清空 */
function normalizeOptionalText(
  value: unknown,
  field: string,
  max: number,
): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new ValidationError('INVALID_BODY', `${field} 必须是字符串或 null`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw new ValidationError('VALUE_TOO_LONG', `${field} 过长（${trimmed.length} 字），上限 ${max} 字`);
  }
  return trimmed;
}

/** 把编辑请求收敛成仓储能接受的 patch；字段未传表示不改 */
export function normalizeCardPatch(input: unknown): {
  patch: { title?: string; time?: string | null; source?: string | null; keyPoints?: string[] };
  reason: CardRevision['reason'];
  note: string | null;
} {
  if (typeof input !== 'object' || input === null) {
    throw new ValidationError('INVALID_BODY', '请求体必须是对象');
  }
  const body = input as Record<string, unknown>;

  if (!isRevisionReason(body.reason)) {
    // 原因必填：没有它，日后无法解释这条为什么和原文不一致
    throw new ValidationError(
      'INVALID_REASON',
      '必须说明修改原因（official / manual / other），否则日后无法追溯这条为什么与原文不同',
    );
  }

  const patch: { title?: string; time?: string | null; source?: string | null; keyPoints?: string[] } = {};

  if (body.title !== undefined) {
    if (typeof body.title !== 'string') {
      throw new ValidationError('INVALID_BODY', 'title 必须是字符串');
    }
    const title = body.title.trim();
    if (title.length === 0) {
      throw new ValidationError('EMPTY_TITLE', '标题不能为空');
    }
    if (title.length > EDIT_MAX_TITLE_LENGTH) {
      throw new ValidationError(
        'VALUE_TOO_LONG',
        `标题过长（${title.length} 字），上限 ${EDIT_MAX_TITLE_LENGTH} 字`,
      );
    }
    patch.title = title;
  }

  if (body.time !== undefined) {
    patch.time = normalizeOptionalText(body.time, '时间', EDIT_MAX_TIME_LENGTH);
  }
  if (body.source !== undefined) {
    patch.source = normalizeOptionalText(body.source, '来源', EDIT_MAX_SOURCE_LENGTH);
  }

  if (body.keyPoints !== undefined) {
    if (!Array.isArray(body.keyPoints)) {
      throw new ValidationError('INVALID_BODY', 'keyPoints 必须是数组');
    }
    const points = body.keyPoints
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    if (points.length === 0) {
      throw new ValidationError('EMPTY_KEY_POINTS', '要点不能为空');
    }
    if (points.length > EDIT_MAX_KEY_POINTS) {
      throw new ValidationError(
        'TOO_MANY_KEY_POINTS',
        `要点最多 ${EDIT_MAX_KEY_POINTS} 条，当前 ${points.length} 条`,
      );
    }
    const tooLong = points.find((point) => point.length > EDIT_MAX_KEY_POINT_LENGTH);
    if (tooLong) {
      throw new ValidationError(
        'VALUE_TOO_LONG',
        `单条要点过长（${tooLong.length} 字），上限 ${EDIT_MAX_KEY_POINT_LENGTH} 字`,
      );
    }
    patch.keyPoints = points;
  }

  if (Object.keys(patch).length === 0) {
    throw new ValidationError('NOTHING_TO_UPDATE', '没有要修改的字段');
  }

  const note = body.note === undefined ? null : normalizeOptionalText(body.note, '修改说明', EDIT_MAX_NOTE_LENGTH);

  return { patch, reason: body.reason, note };
}

function normalizeRawText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ValidationError('INVALID_BODY', 'rawText 必须是字符串');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError('EMPTY_TEXT', '通知内容不能为空');
  }
  if (trimmed.length > MAX_RAW_TEXT_LENGTH) {
    throw new ValidationError(
      'TEXT_TOO_LONG',
      `通知内容过长（${trimmed.length} 字符），上限为 ${MAX_RAW_TEXT_LENGTH} 字符`,
    );
  }
  return trimmed;
}

/**
 * 摘要来源：可以直接给一个固定摘要器（测试里方便），
 * 也可以给 Provider——后者每次请求都取当前设置对应的摘要器，
 * 这样用户在界面上填完 Key 立刻生效，不需要重启服务。
 */
type SummarizerSource = Summarizer | SummarizerProvider;

function isProvider(source: SummarizerSource): source is SummarizerProvider {
  return typeof (source as SummarizerProvider).get === 'function';
}

export interface CardServiceOptions {
  /**
   * 当前时间来源，用于相对日期（今天/明天）与年份推断。
   * 可注入是为了让测试拿到确定结果，而不是跟着运行时间漂。
   */
  now?: () => Date;
}

export function createCardService(
  repo: CardRepository,
  source: SummarizerSource,
  options: CardServiceOptions = {},
): CardService {
  const resolveSummarizer = (): Summarizer => (isProvider(source) ? source.get() : source);
  const now = options.now ?? (() => new Date());

  return {
    async createCard(input) {
      const rawText = normalizeRawText(input.rawText);
      // 关键词是前端传来的自由输入，归一化后最多 MAX_KEYWORDS 个
      const priority = normalizeKeywords(input.keywords);

      const { draft, provider } = await resolveSummarizer().summarize({ rawText, keywords: priority });

      // 确定性兜底：模型有可能漏掉用户明确关心的信息，这里逐词核对并补入证据句
      const checked = enforceKeywords(rawText, draft.keyPoints, priority);

      const keywords: CardKeywords = checked.keywords;

      const createdAt = now();
      // 日历排期从模型给出的时间文本解析。解析不出就是 null——
      // 排不上日历比排错位置安全，界面上会明确说明这张卡没有日期。
      const schedule = parseSchedule(draft.time, { anchor: createdAt });

      const card: InfoCard = {
        id: randomUUID(),
        title: draft.title,
        time: draft.time,
        source: draft.source,
        keyPoints: checked.keyPoints,
        rawText,
        schedule,
        keywords,
        provider,
        createdAt: createdAt.toISOString(),
        updatedAt: null,
        revisionCount: 0,
      };

      return repo.insert(card);
    },

    listCards() {
      return { cards: repo.list(), total: repo.count() };
    },

    getCard(id) {
      assertCardId(id);
      return repo.get(id);
    },

    updateCard(id, input) {
      assertCardId(id);
      const { patch, reason, note } = normalizeCardPatch(input);
      return repo.update(id, patch, reason, note);
    },

    listRevisions(id) {
      assertCardId(id);
      return repo.listRevisions(id);
    },

    clearRevisions(id) {
      assertCardId(id);
      if (!repo.get(id)) return null;
      return repo.clearRevisions(id);
    },

    deleteCard(id) {
      assertCardId(id);
      const existing = repo.get(id);
      if (!existing) return null;
      repo.delete(id);
      return existing;
    },
  };
}
