import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CardKeywords, CardRevision, CardSchedule, InfoCard, SummaryProvider } from '@notification-hub/shared';
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
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  time           TEXT,
  source         TEXT,
  key_points     TEXT NOT NULL,
  raw_text       TEXT NOT NULL,
  provider       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  seq            INTEGER NOT NULL DEFAULT 0,
  keywords       TEXT NOT NULL DEFAULT '{}',
  schedule       TEXT,
  updated_at     TEXT,
  revision_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cards_order ON cards (created_at DESC, seq DESC);

-- 改动历史。存的是"改动前"的内容，所以读出来就是：
-- 因为 reason，把 previous_* 改成了现在这样。
CREATE TABLE IF NOT EXISTS card_revisions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id               TEXT NOT NULL,
  reason                TEXT NOT NULL,
  note                  TEXT,
  previous_title        TEXT NOT NULL,
  previous_time         TEXT,
  previous_source       TEXT,
  previous_key_points   TEXT NOT NULL,
  created_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_card ON card_revisions (card_id, id DESC);
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
  updated_at?: string | null;
  revision_count?: number | null;
}

interface RevisionRow {
  id: number;
  card_id: string;
  reason: string;
  note: string | null;
  previous_title: string;
  previous_time: string | null;
  previous_source: string | null;
  previous_key_points: string;
  created_at: string;
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
    updatedAt: row.updated_at ?? null,
    revisionCount: Number(row.revision_count ?? 0),
  };
}

/** 解析历史行的 reason，非法值归到 other，不让坏数据把界面搞崩 */
function toRevisionReason(value: string): CardRevision['reason'] {
  return value === 'official' || value === 'manual' ? value : 'other';
}

function rowToRevision(row: RevisionRow): CardRevision {
  return {
    id: Number(row.id),
    cardId: row.card_id,
    reason: toRevisionReason(row.reason),
    note: row.note,
    previousTitle: row.previous_title,
    previousTime: row.previous_time,
    previousSource: row.previous_source,
    previousKeyPoints: parseKeyPoints(row.previous_key_points),
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
  if (!has('updated_at')) {
    // 从未编辑过就是 NULL，界面据此判断要不要显示"已修改"标记
    db.exec(`ALTER TABLE cards ADD COLUMN updated_at TEXT`);
  }
  if (!has('revision_count')) {
    db.exec(`ALTER TABLE cards ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0`);
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
  const updateStmt = db.prepare(
    `UPDATE cards
        SET title = ?, time = ?, source = ?, key_points = ?, schedule = ?,
            schedule_computed = 1, updated_at = ?, revision_count = revision_count + 1
      WHERE id = ?`,
  );
  const insertRevisionStmt = db.prepare(
    `INSERT INTO card_revisions
       (card_id, reason, note, previous_title, previous_time, previous_source, previous_key_points, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const listRevisionsStmt = db.prepare(
    `SELECT * FROM card_revisions WHERE card_id = ? ORDER BY id DESC`,
  );
  const deleteRevisionsStmt = db.prepare(`DELETE FROM card_revisions WHERE card_id = ?`);
  const resetRevisionCountStmt = db.prepare(`UPDATE cards SET revision_count = 0 WHERE id = ?`);

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

    update(id, patch, reason, note) {
      const existing = this.get(id);
      if (!existing) return null;

      const nextTitle = patch.title ?? existing.title;
      const nextTime = patch.time !== undefined ? patch.time : existing.time;
      const nextSource = patch.source !== undefined ? patch.source : existing.source;
      const nextKeyPoints = patch.keyPoints ?? existing.keyPoints;

      // 时间变了就重算排期。锚点仍用卡片创建时间：
      // 相对日期（"明天"）指的是通知到达那天，不是改动的这天。
      const anchor = new Date(existing.createdAt);
      const nextSchedule = parseSchedule(nextTime, {
        anchor: Number.isNaN(anchor.getTime()) ? new Date() : anchor,
      });

      const now = new Date().toISOString();

      // 先存旧值再改：这样历史里存的是"改动前"，读出来就是"从什么改成了什么"
      insertRevisionStmt.run(
        id,
        reason,
        note,
        existing.title,
        existing.time,
        existing.source,
        JSON.stringify(existing.keyPoints),
        now,
      );

      updateStmt.run(
        nextTitle,
        nextTime,
        nextSource,
        JSON.stringify(nextKeyPoints),
        nextSchedule ? JSON.stringify(nextSchedule) : null,
        now,
        id,
      );

      return this.get(id);
    },

    listRevisions(cardId) {
      const rows = listRevisionsStmt.all(cardId) as unknown as RevisionRow[];
      return rows.map(rowToRevision);
    },

    clearRevisions(cardId) {
      const existing = this.get(cardId);
      if (!existing) return 0;
      const removed = existing.revisionCount;
      deleteRevisionsStmt.run(cardId);
      // 历史没了，计数也该归零；updatedAt 保留，它记录的是"内容最后一次被改的时间"
      resetRevisionCountStmt.run(cardId);
      return removed;
    },

    delete(id) {
      // 先删历史再删卡片：SQLite 默认不开外键级联，
      // 留着孤儿历史既占空间，也可能在 id 复用时被误读成"这张卡改过"。
      deleteRevisionsStmt.run(id);
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
  const revisions = new Map<string, CardRevision[]>();
  let nextSeq = 1;
  let nextRevisionId = 1;

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
    update(id, patch, reason, note) {
      const existing = cards.get(id);
      if (!existing) return null;

      const now = new Date().toISOString();
      const history = revisions.get(id) ?? [];
      history.unshift({
        id: nextRevisionId,
        cardId: id,
        reason,
        note,
        previousTitle: existing.title,
        previousTime: existing.time,
        previousSource: existing.source,
        previousKeyPoints: [...existing.keyPoints],
        createdAt: now,
      });
      nextRevisionId += 1;
      revisions.set(id, history);

      const nextTime = patch.time !== undefined ? patch.time : existing.time;
      const anchor = new Date(existing.createdAt);

      const updated: InfoCard = {
        ...existing,
        title: patch.title ?? existing.title,
        time: nextTime,
        source: patch.source !== undefined ? patch.source : existing.source,
        keyPoints: patch.keyPoints ?? existing.keyPoints,
        schedule: parseSchedule(nextTime, {
          anchor: Number.isNaN(anchor.getTime()) ? new Date() : anchor,
        }),
        updatedAt: now,
        revisionCount: existing.revisionCount + 1,
      };
      cards.set(id, updated);
      return updated;
    },
    listRevisions(cardId) {
      return revisions.get(cardId) ?? [];
    },
    clearRevisions(cardId) {
      const existing = cards.get(cardId);
      if (!existing) return 0;
      const removed = existing.revisionCount;
      revisions.delete(cardId);
      cards.set(cardId, { ...existing, revisionCount: 0 });
      return removed;
    },
    delete(id) {
      seqs.delete(id);
      revisions.delete(id);
      return cards.delete(id);
    },
    close() {
      cards.clear();
      seqs.clear();
      revisions.clear();
    },
  };
}
