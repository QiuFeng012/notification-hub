import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  CardKeywords,
  CardRevision,
  CardSchedule,
  InfoCard,
  ScheduleRole,
  SummaryProvider,
} from '@notification-hub/shared';
import { DEFAULT_LIST_LIMIT, type CardRepository } from './repository.js';
import { buildSchedules, parseSchedule } from '../calendar/date-parser.js';

/**
 * seq 是单调递增的插入序号，仅用于排序。
 * created_at 只精确到毫秒，同一毫秒内插入的多张卡片时间戳相同；
 * 只按 created_at 排序时顺序不确定（SQLite 可能按主键回退），
 * 因此用 (created_at DESC, seq DESC) 两级排序，保证"最新的排最前"是确定的。
 *
 * keywords / schedule / schedules 都以 JSON 字符串存储：keywords 记录生成时的关注点，
 * schedule 是这张卡在日历上的**主日程**（解析不出为 NULL），
 * schedules 是它的**全部**日程——一条通知可能同时有"报名截止"与"活动开始"两个时间。
 *
 * schedule 保留下来，是因为排序、列表徽标、过期判断都只需要主日程；
 * 它由 schedules 派生（schedules[0] ?? null），避免两处各写一份导致不一致。
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
  schedules      TEXT,
  updated_at     TEXT,
  revision_count INTEGER NOT NULL DEFAULT 0,
  pinned         INTEGER NOT NULL DEFAULT 0
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

/** 数据库里的一行；key_points / keywords / schedule / schedules 以 JSON 字符串存储 */
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
  schedules?: string | null;
  updated_at?: string | null;
  revision_count?: number | null;
  pinned?: number | null;
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
      ...(isScheduleRole(record.role) ? { role: record.role } : {}),
    };
  } catch {
    return null;
  }
}

/** 角色取值校验：坏数据当作没有角色，而不是把它塞进界面当标签 */
function isScheduleRole(value: unknown): value is ScheduleRole {
  return value === 'deadline' || value === 'activity' || value === 'visit' || value === 'primary';
}

/**
 * 解析 schedules 数组。缺失（老数据）或损坏时退回空数组——
 * 调用方会拿 schedule 那一列兜底，所以老卡片不会因此从日历上消失。
 */
function parseStoredSchedules(raw: string | null | undefined): CardSchedule[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => parseStoredSchedule(JSON.stringify(item)))
      .filter((item): item is CardSchedule => item !== null);
  } catch {
    return [];
  }
}

function rowToCard(row: CardRow): InfoCard {
  const storedSchedules = parseStoredSchedules(row.schedules);
  const primary = parseStoredSchedule(row.schedule);
  // schedules 是权威来源；老数据没有这一列时用 schedule 兜底成单条，
  // 两者都没有就是"排不上日历"
  const schedules = storedSchedules.length > 0 ? storedSchedules : primary ? [primary] : [];
  return {
    id: row.id,
    title: row.title,
    time: row.time,
    source: row.source,
    keyPoints: parseKeyPoints(row.key_points),
    rawText: row.raw_text,
    // schedule 由 schedules 派生，保证两者永远一致
    schedule: schedules[0] ?? null,
    schedules,
    keywords: parseKeywords(row.keywords),
    provider: toProvider(row.provider),
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null,
    revisionCount: Number(row.revision_count ?? 0),
    pinned: Number(row.pinned ?? 0) === 1,
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
 * 排期解析的版本号。**改动 date-parser 的解析结果时必须 +1。**
 *
 * 排期是解析结果的**缓存**：改了解析器却不重算，旧卡片会一直显示按老规则算出的
 * 那个日期，而且看不出来是旧的。加了版本号，启动时的回填就知道哪些该重算。
 *
 * 1：初版
 * 2：修掉「10月22号」里的日期读不出来、退化成"本周周四"的缺陷
 *    （示例：10月22号（第八周周四）被排到了 10-15）
 * 3：把一条通知里的"报名截止"与"活动"拆成多条日程（schedules 列）
 *    （示例：9月23日报名截止 + 9月24日活动，原先被合成 9-23~9-24 一个区间）
 * 4：主日程改为 time 指向的那一条，并保证它排在最前
 *    （原先取时间最早的一条：体检卡的时间写着 10-20，日程标签却显示 10-11；
 *     图像采集卡的时间写着 10-18，标签却显示 9-25 的交表截止）
 * 5：角色判得更准（「日期 + 前」算截止；紧接的日期行继承上一句的角色——
 *    只继承以「时间/截止」收尾的标题行，不继承任意上一句），
 *    并且主日程不再被强制写成 primary——多日期卡片靠角色标签区分每一条
 */
const SCHEDULE_VERSION = 6;

/**
 * 轻量迁移：给老数据库补上没有的列。
 * SQLite 没有 "ADD COLUMN IF NOT EXISTS"，所以先查表结构再决定加不加。
 * 不做通用迁移框架——目前只有这几处，等再多一处再抽象。
 *
 * schedule_computed 是刻意加的一列：schedule 为 NULL 有两种含义——
 * "算过但解析不出日期" 与 "还没算过（老数据）"。没有这个标记就无法区分，
 * 会导致老卡片永远进不了日历，或者每次启动都把所有卡片重算一遍。
 *
 * schedule_version 换掉了"算过没有"这个布尔量：光有布尔量答不出
 * "按哪一版规则算的"，解析器一升级旧卡片就永远停在错的日期上。
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
  if (!has('schedules')) {
    // 可空：这一列是"全部日程"。老数据没有它，读的时候会用 schedule 兜底成单条，
    // 然后由下面的版本号触发重算补上
    db.exec(`ALTER TABLE cards ADD COLUMN schedules TEXT`);
  }
  if (!has('schedule_computed')) {
    // 已有 schedule 的都是新数据（算过），老数据默认为 0 等着回填
    db.exec(`ALTER TABLE cards ADD COLUMN schedule_computed INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE cards SET schedule_computed = 1 WHERE schedule IS NOT NULL`);
  }
  if (!has('schedule_version')) {
    db.exec(`ALTER TABLE cards ADD COLUMN schedule_version INTEGER NOT NULL DEFAULT 0`);
    // 已经算过的那些是按"上一版"算的，标成 1 让它们等着被重算；
    // 没算过的保持 0，同样等着被算。
    db.exec(`UPDATE cards SET schedule_version = 1 WHERE schedule_computed = 1`);
  }
  if (!has('updated_at')) {
    // 从未编辑过就是 NULL，界面据此判断要不要显示"已修改"标记
    db.exec(`ALTER TABLE cards ADD COLUMN updated_at TEXT`);
  }
  if (!has('revision_count')) {
    db.exec(`ALTER TABLE cards ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!has('pinned')) {
    // 用 0/1 而不是布尔：SQLite 没有布尔类型
    db.exec(`ALTER TABLE cards ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
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
    `INSERT INTO cards (id, title, time, source, key_points, raw_text, provider, created_at, seq, keywords, schedule, schedules, schedule_computed, schedule_version, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  const setPinnedStmt = db.prepare(`UPDATE cards SET pinned = ? WHERE id = ?`);
  const deleteStmt = db.prepare(`DELETE FROM cards WHERE id = ?`);
  const updateStmt = db.prepare(
    `UPDATE cards
        SET title = ?, time = ?, source = ?, key_points = ?, raw_text = ?, schedule = ?, schedules = ?,
            schedule_computed = 1, schedule_version = ?,
            updated_at = ?, revision_count = revision_count + 1
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
   * 重算排期：把按旧版（或从未）解析过的卡片重新解析一遍。
   *
   * 日历功能上线前创建的卡片 schedule 是 NULL。如果不重算，这些"老卡片"
   * 永远进不了日历，而这跟"解析不出日期"在界面上长得一样，用户会以为功能坏了。
   *
   * 解析器修好之后（见 SCHEDULE_VERSION）同样需要这一步：排期是解析结果的缓存，
   * 不重算的话旧卡片会一直显示按老规则算出来的那个日期。
   *
   * 锚点用卡片自己的创建时间，而不是"现在"——否则相对日期（今天/明天）
   * 会被按今天重新解释，把历史排期算到错误的日子上。
   * 解析不出来也标记为"按当前版本算过了"，避免每次启动重复劳动。
   *
   * 只动 schedule / schedules 与 schedule_version：不碰 updated_at、revision_count，
   * 也不写改动历史——重算不是用户做的修改，不该在卡片上留下"已修改 N 次"。
   */
  function backfillSchedules(): void {
    const pending = db
      .prepare(`SELECT id, time, raw_text, created_at FROM cards WHERE schedule_version < ?`)
      .all(SCHEDULE_VERSION) as unknown as Array<{
      id: string;
      time: string | null;
      raw_text: string;
      created_at: string;
    }>;
    if (pending.length === 0) return;

    const update = db.prepare(
      `UPDATE cards SET schedule = ?, schedules = ?, schedule_computed = 1, schedule_version = ? WHERE id = ?`,
    );
    for (const row of pending) {
      const anchor = new Date(row.created_at);
      const options = {
        anchor: Number.isNaN(anchor.getTime()) ? new Date() : anchor,
        timeText: row.time,
      };
      // 从原文拆分（可能得到多条），解析不出来时退回 time 文本的单条
      const schedules = buildSchedules(row.raw_text, options);
      const fallback = schedules.length === 0 ? parseSchedule(row.time, options) : null;
      const all = schedules.length > 0 ? schedules : fallback ? [fallback] : [];
      update.run(
        all[0] ? JSON.stringify(all[0]) : null,
        all.length > 0 ? JSON.stringify(all) : null,
        SCHEDULE_VERSION,
        row.id,
      );
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
        card.schedules.length > 0 ? JSON.stringify(card.schedules) : null,
        SCHEDULE_VERSION,
        card.pinned ? 1 : 0,
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
      // 原文也可能被换掉（官方改了通知）。排期必须按**新原文**算，
      // 否则新文本里的日期永远进不了日历。
      const nextRawText = patch.rawText ?? existing.rawText;

      // 排期**每次都重算**，不只在时间文本变化时算。
      //
      // 三个理由：
      //   1. 它本来就是"当前时间文本与原文的确定性函数"，重复算结果一致；
      //   2. 只认"时间变了"会漏掉一类真实情况——用户这轮只改了标题或要点，
      //      但排期其实早就该重新解析了（比如解析规则本身修过）。
      //      那时排期会一直停在旧值上，而用户改的明明是别的东西；
      //   3. 一条通知里的"报名截止"与"活动"要拆成多条，这同样与"时间变没变"无关。
      //
      // 锚点仍用卡片创建时间：相对日期（"明天"）指的是通知到达那天，不是改动的这天。
      const anchor = new Date(existing.createdAt);
      const options = {
        anchor: Number.isNaN(anchor.getTime()) ? new Date() : anchor,
        timeText: nextTime,
      };
      // 优先用调用方算好的（服务端装配时已经算过一次，不必重复劳动）；
      // 没给就按当前时间文本与原文现算。
      const fromRaw = patch.schedules ?? buildSchedules(nextRawText, options);
      const nextSchedules = fromRaw.length > 0 ? fromRaw : (() => {
        const single = parseSchedule(nextTime, options);
        return single ? [single] : [];
      })();

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
        nextRawText,
        nextSchedules[0] ? JSON.stringify(nextSchedules[0]) : null,
        nextSchedules.length > 0 ? JSON.stringify(nextSchedules) : null,
        SCHEDULE_VERSION,
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

    setPinned(id, pinned) {
      const existing = this.get(id);
      if (!existing) return null;
      setPinnedStmt.run(pinned ? 1 : 0, id);
      return this.get(id);
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
      const nextRawText = patch.rawText ?? existing.rawText;
      const anchor = new Date(existing.createdAt);
      const options = {
        anchor: Number.isNaN(anchor.getTime()) ? new Date() : anchor,
        timeText: nextTime,
      };
      // 与 sqlite 版同样的口径：每次都重算、优先用调用方算好的、退回 time 单条
      const fromRaw = patch.schedules ?? buildSchedules(nextRawText, options);
      const nextSchedules = fromRaw.length > 0 ? fromRaw : (() => {
        const single = parseSchedule(nextTime, options);
        return single ? [single] : [];
      })();

      const updated: InfoCard = {
        ...existing,
        title: patch.title ?? existing.title,
        time: nextTime,
        source: patch.source !== undefined ? patch.source : existing.source,
        keyPoints: patch.keyPoints ?? existing.keyPoints,
        rawText: nextRawText,
        schedule: nextSchedules[0] ?? null,
        schedules: nextSchedules,
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
    setPinned(id, pinned) {
      const existing = cards.get(id);
      if (!existing) return null;
      const updated = { ...existing, pinned };
      cards.set(id, updated);
      return updated;
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
