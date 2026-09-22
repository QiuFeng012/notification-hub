import { randomUUID } from 'node:crypto';
import { MAX_RAW_TEXT_LENGTH, type InfoCard } from '@notification-hub/shared';
import type { Summarizer } from '../ai/types.js';
import type { CardRepository } from '../db/repository.js';

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
}

export interface CardService {
  createCard(input: CreateCardInput): Promise<InfoCard>;
  listCards(): { cards: InfoCard[]; total: number };
  /** 删除并返回被删掉的信息卡，目标不存在返回 null */
  deleteCard(id: string): InfoCard | null;
}

/** UUID v4：只接受服务端自己生成过的 id 形态，避免把任意字符串丢进 SQL */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export function createCardService(repo: CardRepository, summarizer: Summarizer): CardService {
  return {
    async createCard(input) {
      const rawText = normalizeRawText(input.rawText);
      const { draft, provider } = await summarizer.summarize(rawText);

      const card: InfoCard = {
        id: randomUUID(),
        title: draft.title,
        time: draft.time,
        source: draft.source,
        keyPoints: draft.keyPoints,
        rawText,
        provider,
        createdAt: new Date().toISOString(),
      };

      return repo.insert(card);
    },

    listCards() {
      return { cards: repo.list(), total: repo.count() };
    },

    deleteCard(id) {
      if (!UUID_PATTERN.test(id)) {
        throw new ValidationError('INVALID_ID', `信息卡 ID 格式不正确：${id}`);
      }
      const existing = repo.get(id);
      if (!existing) return null;
      repo.delete(id);
      return existing;
    },
  };
}
