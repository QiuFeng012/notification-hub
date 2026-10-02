import type { CardRevision, InfoCard } from '@notification-hub/shared';

/** 一次编辑的输入：只包含要改的字段，未传的保持不变 */
export interface CardUpdateInput {
  title?: string;
  time?: string | null;
  source?: string | null;
  keyPoints?: string[];
}

/**
 * 信息卡仓储接口。
 * 抽成接口是为了让 API 层测试可以注入内存实现，无需碰真实 SQLite 文件。
 */
export interface CardRepository {
  /** 按创建时间倒序返回，最新的在最前 */
  list(limit?: number): InfoCard[];
  count(): number;
  get(id: string | undefined): InfoCard | null;
  insert(card: InfoCard): InfoCard;
  /**
   * 局部更新一张卡片。
   *
   * 改动**前**的内容会作为一条历史快照存下来，所以调用方不需要自己先读一遍。
   * 目标不存在时返回 null。
   */
  update(
    id: string,
    patch: CardUpdateInput,
    reason: CardRevision['reason'],
    note: string | null,
  ): InfoCard | null;
  /** 某张卡片的改动历史，最新的在最前 */
  listRevisions(cardId: string): CardRevision[];
  /**
   * 清空某张卡片的改动历史，并把 revisionCount 归零。
   * 用于把"验证/误操作"留下的记录整理掉；内容本身不动。
   */
  clearRevisions(cardId: string): number;
  /** 删除成功返回 true，目标不存在返回 false */
  delete(id: string): boolean;
  /** 释放底层资源 */
  close(): void;
}

/** 列表接口默认返回条数，防止历史积累后一次性拖垮前端 */
export const DEFAULT_LIST_LIMIT = 200;
