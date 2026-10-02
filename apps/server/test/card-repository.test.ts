import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import type { InfoCard } from '@notification-hub/shared';
import {
  createMemoryCardRepository,
  createSqliteCardRepository,
} from '../src/db/sqlite-repository.js';

function makeCard(overrides: Partial<InfoCard> = {}): InfoCard {
  return {
    id: crypto.randomUUID(),
    title: '通知标题',
    time: '3月8日24:00前',
    source: '教务处',
    keyPoints: ['要点一', '要点二'],
    rawText: '通知原文',
    schedule: null,
    keywords: { priority: [], hit: [], missed: [] },
    provider: 'mock',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'notification-hub-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'nested', 'cards.db');
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('sqlite 仓储', () => {
  it('自动创建缺失的目录与数据表', () => {
    const repo = createSqliteCardRepository(tempDbPath());
    try {
      assert.equal(repo.count(), 0);
      assert.deepEqual(repo.list(), []);
    } finally {
      repo.close();
    }
  });

  it('写入后能原样读回全部字段', () => {
    const repo = createSqliteCardRepository(tempDbPath());
    try {
      const card = makeCard();
      repo.insert(card);
      assert.deepEqual(repo.get(card.id), card);
    } finally {
      repo.close();
    }
  });

  it('列表按创建时间倒序，最新的在最前', () => {
    const repo = createSqliteCardRepository(tempDbPath());
    try {
      const older = makeCard({ title: '早', createdAt: '2025-03-01T10:00:00.000Z' });
      const newer = makeCard({ title: '晚', createdAt: '2025-03-05T10:00:00.000Z' });
      repo.insert(older);
      repo.insert(newer);
      assert.deepEqual(
        repo.list().map((card) => card.title),
        ['晚', '早'],
      );
    } finally {
      repo.close();
    }
  });

  it('同一毫秒创建的多张卡片仍按插入顺序倒序排列', () => {
    const repo = createSqliteCardRepository(tempDbPath());
    try {
      const sameMoment = '2025-03-05T10:00:00.000Z';
      const first = makeCard({ title: '第一张', createdAt: sameMoment });
      const second = makeCard({ title: '第二张', createdAt: sameMoment });
      const third = makeCard({ title: '第三张', createdAt: sameMoment });
      repo.insert(first);
      repo.insert(second);
      repo.insert(third);

      assert.deepEqual(
        repo.list().map((card) => card.title),
        ['第三张', '第二张', '第一张'],
      );
    } finally {
      repo.close();
    }
  });

  it('列表支持 limit', () => {
    const repo = createSqliteCardRepository(tempDbPath());
    try {
      repo.insert(makeCard({ createdAt: '2025-03-01T10:00:00.000Z' }));
      repo.insert(makeCard({ createdAt: '2025-03-02T10:00:00.000Z' }));
      assert.equal(repo.list(1).length, 1);
      assert.equal(repo.count(), 2);
    } finally {
      repo.close();
    }
  });

  it('保存 time/source 为 null 的卡片', () => {
    const repo = createSqliteCardRepository(tempDbPath());
    try {
      const card = makeCard({ time: null, source: null });
      repo.insert(card);
      const loaded = repo.get(card.id);
      assert.equal(loaded?.time, null);
      assert.equal(loaded?.source, null);
    } finally {
      repo.close();
    }
  });

  it('删除返回 true，重复删除返回 false', () => {
    const repo = createSqliteCardRepository(tempDbPath());
    try {
      const card = makeCard();
      repo.insert(card);
      assert.equal(repo.delete(card.id), true);
      assert.equal(repo.delete(card.id), false);
      assert.equal(repo.get(card.id), null);
    } finally {
      repo.close();
    }
  });

  it('数据在重新打开数据库后依然存在', () => {
    const dbPath = tempDbPath();
    const first = createSqliteCardRepository(dbPath);
    const card = makeCard();
    first.insert(card);
    first.close();

    const second = createSqliteCardRepository(dbPath);
    try {
      assert.deepEqual(second.get(card.id), card);
      assert.equal(second.count(), 1);
    } finally {
      second.close();
    }
  });

  it('关键词记录能被完整保存与读回', () => {
    const repo = createSqliteCardRepository(tempDbPath());
    try {
      const card = makeCard({
        keywords: { priority: ['面试', '报销'], hit: ['面试'], missed: ['报销'] },
      });
      repo.insert(card);
      assert.deepEqual(repo.get(card.id)?.keywords, {
        priority: ['面试', '报销'],
        hit: ['面试'],
        missed: ['报销'],
      });
    } finally {
      repo.close();
    }
  });

  it('没有关键词的卡片读回空记录而不是 undefined', () => {
    const repo = createSqliteCardRepository(tempDbPath());
    try {
      const card = makeCard();
      repo.insert(card);
      assert.deepEqual(repo.get(card.id)?.keywords, { priority: [], hit: [], missed: [] });
    } finally {
      repo.close();
    }
  });

  it('老数据库缺少 keywords 列时自动补列，已有数据不丢', () => {
    const dbPath = tempDbPath();
    // 模拟升级前的库：没有 keywords 列。DatabaseSync 不会自动建目录，先建好
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE cards (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, time TEXT, source TEXT,
        key_points TEXT NOT NULL, raw_text TEXT NOT NULL,
        provider TEXT NOT NULL, created_at TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0
      );
    `);
    legacy
      .prepare(
        `INSERT INTO cards (id, title, key_points, raw_text, provider, created_at, seq)
         VALUES ('legacy-id', '老卡片', '["旧要点"]', '旧原文', 'mock', '2025-01-01T00:00:00.000Z', 1)`,
      )
      .run();
    legacy.close();

    const repo = createSqliteCardRepository(dbPath);
    try {
      const card = repo.get('legacy-id');
      assert.equal(card?.title, '老卡片', '迁移后老数据必须还在');
      assert.deepEqual(card?.keyPoints, ['旧要点']);
      assert.deepEqual(card?.keywords, { priority: [], hit: [], missed: [] });
    } finally {
      repo.close();
    }
  });

  it('日程能被完整保存与读回', () => {
    const repo = createSqliteCardRepository(tempDbPath());
    try {
      const card = makeCard({
        schedule: {
          start: '2025-03-05',
          end: '2025-03-08',
          dayCount: 4,
          label: '3月5日至3月8日',
          inferredYear: true,
        },
      });
      repo.insert(card);
      assert.deepEqual(repo.get(card.id)?.schedule, {
        start: '2025-03-05',
        end: '2025-03-08',
        dayCount: 4,
        label: '3月5日至3月8日',
        inferredYear: true,
      });
    } finally {
      repo.close();
    }
  });

  it('解析不出日期的卡片读回 null 而不是报错', () => {
    const repo = createSqliteCardRepository(tempDbPath());
    try {
      const card = makeCard({ schedule: null });
      repo.insert(card);
      assert.equal(repo.get(card.id)?.schedule, null);
    } finally {
      repo.close();
    }
  });

  it('老数据库里能解析出日期的卡片会被自动回填排期', () => {
    const dbPath = tempDbPath();
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE cards (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, time TEXT, source TEXT,
        key_points TEXT NOT NULL, raw_text TEXT NOT NULL,
        provider TEXT NOT NULL, created_at TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0
      );
    `);
    const insert = legacy.prepare(
      `INSERT INTO cards (id, title, time, key_points, raw_text, provider, created_at, seq)
       VALUES (?, ?, ?, '["要点"]', '原文', 'mock', ?, ?)`,
    );
    // 卡片的创建时间是 2026-09-20，用它推断年份应是 2026 而不是"现在"
    insert.run('has-date', '有日期的老卡', '9月28日至9月30日', '2026-09-20T10:00:00.000Z', 1);
    insert.run('no-date', '没日期的老卡', '待定', '2026-09-20T10:00:00.000Z', 2);
    insert.run('null-time', '时间为空的老卡', null, '2026-09-20T10:00:00.000Z', 3);
    legacy.close();

    const repo = createSqliteCardRepository(dbPath);
    try {
      const scheduled = repo.get('has-date');
      assert.equal(scheduled?.schedule?.start, '2026-09-28');
      assert.equal(scheduled?.schedule?.end, '2026-09-30');
      assert.equal(scheduled?.schedule?.dayCount, 3);

      // 解析不出来的保持 null，但要标记为已算过
      assert.equal(repo.get('no-date')?.schedule, null);
      assert.equal(repo.get('null-time')?.schedule, null);
    } finally {
      repo.close();
    }
  });

  it('回填只做一次：再次打开不会重复计算', () => {
    const dbPath = tempDbPath();
    mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE cards (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, time TEXT, source TEXT,
        key_points TEXT NOT NULL, raw_text TEXT NOT NULL,
        provider TEXT NOT NULL, created_at TEXT NOT NULL, seq INTEGER NOT NULL DEFAULT 0
      );
    `);
    legacy
      .prepare(
        `INSERT INTO cards (id, title, time, key_points, raw_text, provider, created_at, seq)
         VALUES ('c1', '卡', '9月28日', '["要点"]', '原文', 'mock', '2026-09-20T10:00:00.000Z', 1)`,
      )
      .run();
    legacy.close();

    const first = createSqliteCardRepository(dbPath);
    const initial = first.get('c1')?.schedule?.start;
    first.close();

    // 直接看数据库：回填后应标记为已算过，第二次打开不该再有待回填的行
    const inspect = new DatabaseSync(dbPath);
    const pending = inspect
      .prepare(`SELECT COUNT(*) AS total FROM cards WHERE schedule_computed = 0`)
      .get() as unknown as { total: number };
    inspect.close();
    assert.equal(Number(pending.total), 0, '回填后不应留下待处理行');

    const second = createSqliteCardRepository(dbPath);
    try {
      assert.equal(second.get('c1')?.schedule?.start, initial, '再次打开结果一致');
    } finally {
      second.close();
    }
  });

  it('中文与换行内容不会损坏', () => {
    const repo = createSqliteCardRepository(tempDbPath());
    try {
      const card = makeCard({
        title: '【提醒】明天停水',
        keyPoints: ['第一行\n第二行', '含 "引号" 与 emoji 🎉'],
      });
      repo.insert(card);
      assert.deepEqual(repo.get(card.id)?.keyPoints, card.keyPoints);
    } finally {
      repo.close();
    }
  });
});

describe('内存仓储', () => {
  it('与 sqlite 行为一致：倒序、计数、删除', () => {
    const repo = createMemoryCardRepository();
    const older = makeCard({ createdAt: '2025-03-01T10:00:00.000Z' });
    const newer = makeCard({ createdAt: '2025-03-05T10:00:00.000Z' });
    repo.insert(older);
    repo.insert(newer);

    assert.equal(repo.count(), 2);
    assert.equal(repo.list()[0]?.id, newer.id);
    assert.equal(repo.get(older.id)?.id, older.id);
    assert.equal(repo.delete(older.id), true);
    assert.equal(repo.count(), 1);
    assert.equal(repo.get('不存在的-id'), null);
  });

  it('同一毫秒插入时按插入顺序倒序', () => {
    const repo = createMemoryCardRepository();
    const sameMoment = '2025-03-05T10:00:00.000Z';
    const first = makeCard({ title: '第一张', createdAt: sameMoment });
    const second = makeCard({ title: '第二张', createdAt: sameMoment });
    repo.insert(first);
    repo.insert(second);

    assert.deepEqual(
      repo.list().map((card) => card.title),
      ['第二张', '第一张'],
    );
  });
});
