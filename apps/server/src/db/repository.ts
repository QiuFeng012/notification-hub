import type { InfoCard } from '@notification-hub/shared';

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
  /** 删除成功返回 true，目标不存在返回 false */
  delete(id: string): boolean;
  /** 释放底层资源 */
  close(): void;
}

/** 列表接口默认返回条数，防止历史积累后一次性拖垮前端 */
export const DEFAULT_LIST_LIMIT = 200;
