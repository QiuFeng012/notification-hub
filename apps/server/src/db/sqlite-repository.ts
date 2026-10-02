import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CardKeywords, CardSchedule, InfoCard, SummaryProvider } from '@notification-hub/shared';
import { DEFAULT_LIST_LIMIT, type CardRepository } from './repository.js';
import { parseSchedule } from '../calendar/date-parser.js';

/**
 * seq 是单调递增的插入序号，仅用于排序。
 * created_at 只精确到毫秒，同一毫秒内插入的多张卡片时间戳相同；
 * 只按 created_at 排序时顺序不确定（SQLite 可能按主键回退），
 * 因此用 (created_at DESC, seq DESC) 两级排序，保证"最新的排最前"是确定的。
 *
 * keywords 与 schedule 以 JSON 字符串存储：前者记录生成时的关注点，
 * 后者是从 time 文本确定性解析出的日历排期（解析不出为 NULL）。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  time        TEXT,
  source      TEXT,
  key_points  TEXT NOT NULL,
  raw_text    TEXT NOT NULL,
  provider    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 0,
  keywords    TEXT NOT NULL DEFAULT '{}',
  schedule    TEXT
);
CREATE INDEX IF NOT EXISTS idx_cards_order ON cards (created_at DESC, seq DESC);
`;

/** 数据库里的一行；key_points / keywords / schedule 以 JSON 字符串存储 */
interface CardRow {
  id: string;
  title: string;
  time: string | null;
  source: string | null;
  key_points: string;
  raw_text: string;
  provider: string;
  created_at: string;
  keywords?: string | null;
  schedule?: string | null;
}

const EMPTY_KEYWORDS: CardKeywords = { priority: [], hit: [], missed: [] };

function toProvider(value: string): SummaryProvider {
  return value === 'deepseek' ? 'deepseek' : 'mock';
}

/** 容错解析 key_points：数据被手工改坏时不至于让整个列表接口 500 */
function parseKeyPoints(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

/** 解析关键词记录，缺失或损坏时退回空记录（老数据没有这一列） */
function parseKeywords(raw: string | null | undefined): CardKeywords {
  if (!raw) return EMPTY_KEYWORDS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_KEYWORDS;
    const record = parsed as Record<string, unknown>;
    const toList = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    return {
      priority: toList(record.priority),
      hit: toList(record.hit),
      missed: toList(record.missed),
    };
  } catch {
    return EMPTY_KEYWORDS;
  }
}

/** 解析数据库里存的日程 JSON，缺失或损坏时返回 null */
function parseStoredSchedule(raw: string | null | undefined): CardSchedule | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.start !== 'string' || typeof record.end !== 'string') return null;
    return {
      start: record.start,
      end: record.end,
      dayCount: typeof record.dayCount === 'number' ? record.dayCount : 1,
      label: typeof record.label === 'string' ? record.label : '',
      inferredYear: record.inferredYear === true,
    };
  } catch {
    return null;
  }
}

function rowToCard(row: CardRow): InfoCard {
  return {
    id: row.id,
    title: row.title,
    time: row.time,
    source: row.source,
    keyPoints: parseKeyPoints(row.key_points),
    rawText: row.raw_text,
    schedule: parseStoredSchedule(row.schedule),
    keywords: parseKeywords(row.keywords),
    provider: toProvider(row.provider),
    createdAt: row.created_at,
  };
}

/**
 * 轻量迁移：给老数据库补上没有的列。
 * SQLite 没有 "ADD COLUMN IF NOT EXISTS"，所以先查表结构再决定加不加。
 * 不做通用迁移框架——目前只有三处，等真有第五处再抽象。
 *
 * schedule_computed 是刻意加的一列：schedule 为 NULL 有两种含义——
 * "算过但解析不出日期" 与 "还没算过（老数据）"。没有这个标记就无法区分，
 * 会导致老卡片永远进不了日历，或者每次启动都把所有卡片重算一遍。
 */
function migrate(db: DatabaseSync): void {
  const columns = db.prepare(`PRAGMA table_info(cards)`).all() as unknown as Array<{ name: string }>;
  const has = (name: string) => columns.some((column) => column.name === name);

  if (!has('keywords')) {
    db.exec(`ALTER TABLE cards ADD COLUMN keywords TEXT NOT NULL DEFAULT '{}'`);
  }
  if (!has('schedule')) {
    // 可空：老卡片没有排期，解析不出来时也是 NULL
    db.exec(`ALTER TABLE cards ADD COLUMN schedule TEXT`);
  }
  if (!has('schedule_computed')) {
    // 已有 schedule 的都是新数据（算过），老数据默认为 0 等着回填
    db.exec(`ALTER TABLE cards ADD COLUMN schedule_computed INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE cards SET schedule_computed = 1 WHERE schedule IS NOT NULL`);
  }
}

/**
 * 基于 Node 24 内置 node:sqlite 的仓储实现。
 * 选内置模块而非 better-sqlite3，是为了零原生依赖、免编译、装完即用。
 */
export function createSqliteCardRepository(dbPath: string): CardRepository {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  migrate(db);

  const listStmt = db.prepare(
    `SELECT * FROM cards ORDER BY created_at DESC, seq DESC LIMIT ?`,
  );
  const countStmt = db.prepare(`SELECT COUNT(*) AS total FROM cards`);
  const getStmt = db.prepare(`SELECT * FROM cards WHERE id = ?`);
  // 单用户本地应用 + node:sqlite 同步 API，不存在并发插入，MAX(seq)+1 是安全的
  const nextSeqStmt = db.prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM cards`);
  const insertStmt = db.prepare(
    `INSERT INTO cards (id, title, time, source, key_points, raw_text, provider, created_at, seq, keywords, schedule, schedule_computed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  const deleteStmt = db.prepare(`DELETE FROM cards WHERE id = ?`);

  /**
   * 回填历史卡片的排期。
   *
   * 日历功能上线前创建的卡片 schedule 是 NULL。如果不回填，
   * 这些"老卡片"永远进不了日历，而这跟"解析不出日期"在界面上长得一样，
   * 用户会以为功能坏了。
   *
   * 锚点用卡片自己的创建时间，而不是"现在"——否则相对日期（今天/明天）
   * 会被按今天重新解释，把历史排期算到错误的日子上。
   * 算不出来也标记为已算过，避免每次启动重复劳动。
   */
  function backfillSchedules(): void {
    const pending = db
      .prepare(`SELECT id, time, created_at FROM cards WHERE schedule_computed = 0`)
      .all() as unknown as Array<{ id: string; time: string | null; created_at: string }>;
    if (pending.length === 0) return;

    const update = db.prepare(`UPDATE cards SET schedule = ?, schedule_computed = 1 WHERE id = ?`);
    for (const row of pending) {
      const anchor = new Date(row.created_at);
      const schedule = parseSchedule(row.time, {
        anchor: Number.isNaN(anchor.getTime()) ? new Date() : anchor,
      });
      update.run(schedule ? JSON.stringify(schedule) : null, row.id);
    }
  }

  backfillSchedules();

  return {
    list(limit = DEFAULT_LIST_LIMIT) {
      const rows = listStmt.all(limit) as unknown as CardRow[];
      return rows.map(rowToCard);
    },

    count() {
      const row = countStmt.get() as unknown as { total: number };
      return Number(row.total);
    },

    get(id) {
      if (!id) return null;
      const row = getStmt.get(id) as unknown as CardRow | undefined;
      return row ? rowToCard(row) : null;
    },

    insert(card) {
      const { next } = nextSeqStmt.get() as unknown as { next: number };
      insertStmt.run(
        card.id,
        card.title,
        card.time,
        card.source,
        JSON.stringify(card.keyPoints),
        card.rawText,
        card.provider,
        card.createdAt,
        Number(next),
        JSON.stringify(card.keywords),
        card.schedule ? JSON.stringify(card.schedule) : null,
      );
      return card;
    },

    delete(id) {
      const result = deleteStmt.run(id);
      return Number(result.changes) > 0;
    },

    close() {
      db.close();
    },
  };
}

/** 测试专用：纯内存仓储，避免测试污染真实数据库文件 */
export function createMemoryCardRepository(): CardRepository {
  const cards = new Map<string, InfoCard>();
  const seqs = new Map<string, number>();
  let nextSeq = 1;

  /** 与 sqlite 版一致的两级排序：先比创建时间，再比插入序号 */
  const ordered = () =>
    [...cards.values()].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt.localeCompare(a.createdAt);
      return (seqs.get(b.id) ?? 0) - (seqs.get(a.id) ?? 0);
    });

  return {
    list(limit = DEFAULT_LIST_LIMIT) {
      return ordered().slice(0, limit);
    },
    count() {
      return cards.size;
    },
    get(id) {
      if (!id) return null;
      return cards.get(id) ?? null;
    },
    insert(card) {
      cards.set(card.id, card);
      seqs.set(card.id, nextSeq);
      nextSeq += 1;
      return card;
    },
    delete(id) {
      seqs.delete(id);
      return cards.delete(id);
    },
    close() {
      cards.clear();
      seqs.clear();
    },
  };
}
