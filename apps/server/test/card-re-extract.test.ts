import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryCardRepository } from '../src/db/sqlite-repository.js';
import type { CardRepository } from '../src/db/repository.js';
import { createCardService, ValidationError } from '../src/services/card-service.js';
import type { Summarizer } from '../src/ai/types.js';
import type { InfoCard } from '@notification-hub/shared';

/** 固定输出，便于断言；真实摘要器在别处单测 */
function stubSummarizer(draft: {
  title: string;
  time: string | null;
  source: string | null;
  keyPoints: string[];
}): Summarizer {
  return {
    async summarize() {
      return { draft, provider: 'mock' as const };
    },
  };
}

/** 锚点固定，避免结果跟着运行时间漂 */
const NOW = new Date(2026, 9, 13, 12, 0, 0); // 2026-10-13 本地时间

function makeCard(overrides: Partial<InfoCard> = {}): InfoCard {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    title: '宿舍内务卫生检查通知',
    time: '10月15日',
    source: '学生自律委员会',
    keyPoints: ['检查时间待定'],
    rawText: '原通知：检查时间另行通知。',
    schedule: { start: '2026-10-15', end: '2026-10-15', dayCount: 1, label: '10月15日', inferredYear: true },
    keywords: { priority: ['检查时间'], hit: [], missed: [] },
    provider: 'mock',
    createdAt: NOW.toISOString(),
    updatedAt: null,
    revisionCount: 0,
    pinned: false,
    ...overrides,
  };
}

function makeService(draft: Parameters<typeof stubSummarizer>[0], card: InfoCard = makeCard()) {
  const repo: CardRepository = createMemoryCardRepository();
  repo.insert(card);
  const service = createCardService(repo, stubSummarizer(draft), { now: () => NOW });
  return { repo, service, card };
}

describe('previewReExtract', () => {
  it('按新原文重新提炼，但不改动已存的卡片', async () => {
    const { repo, service, card } = makeService({
      title: '卫生检查改到10月22日',
      time: '10月22日14:30-17:30',
      source: '自律委员会',
      keyPoints: ['检查时间改为10月22日14:30-17:30'],
    });

    const preview = await service.previewReExtract(card.id, {
      rawText: '更新：本学期第一次宿舍内务卫生检查改到10月22日14:30-17:30进行。',
    });

    assert.ok(preview);
    assert.equal(preview.title, '卫生检查改到10月22日');
    assert.equal(preview.time, '10月22日14:30-17:30');
    assert.equal(preview.source, '自律委员会');
    assert.deepEqual(preview.keyPoints, ['检查时间改为10月22日14:30-17:30']);
    assert.equal(preview.provider, 'mock');

    // 关键：预览不落库。用户还没确认，卡片必须一个字都没变
    const stored = repo.get(card.id);
    assert.equal(stored?.title, '宿舍内务卫生检查通知');
    assert.equal(stored?.time, '10月15日');
    assert.equal(stored?.revisionCount, 0, '预览不该产生改动记录');
  });

  it('顺带给出新原文的排期，让用户确认前就知道会落到哪天', async () => {
    const { service, card } = makeService({
      title: '检查改期',
      time: '10月22日',
      source: null,
      keyPoints: ['检查改为10月22日'],
    });

    const preview = await service.previewReExtract(card.id, {
      rawText: '检查改到10月22日。',
    });

    assert.equal(preview?.schedule?.start, '2026-10-22');
    // 锚点是卡片创建时间（10-13），10-22 在同一年，不该被推到明年
    assert.equal(preview?.schedule?.end, '2026-10-22');
  });

  it('沿用卡片自己的关注点，漏掉时照样补证据句', async () => {
    // 卡片生成时用户关注的「检查时间」，官方新原文里也提到了它
    const { service, card } = makeService({
      title: '检查改期',
      time: '10月22日',
      source: null,
      // 模型这条要点完全没提「检查时间」，应当被兜底补一条
      keyPoints: ['请各宿舍留人配合'],
    });

    const preview = await service.previewReExtract(card.id, {
      rawText: '关于检查时间的更新：检查时间改为10月22日。请各宿舍留人配合。',
    });

    assert.ok(preview);
    assert.deepEqual(preview.supplementedKeywords, ['检查时间']);
    assert.ok(
      preview.keyPoints.some((point) => point.includes('检查时间')),
      `补入的要点应含「检查时间」，实际：${JSON.stringify(preview.keyPoints)}`,
    );
  });

  it('卡片不存在时返回 null，而不是抛错', async () => {
    const { service } = makeService({
      title: 'x',
      time: null,
      source: null,
      keyPoints: ['x'],
    });
    const result = await service.previewReExtract('11111111-2222-3333-4444-555555555555', {
      rawText: '随便一段原文。',
    });
    assert.equal(result, null);
  });

  it('新原文为空或过长时按与新建相同的一套规则拒绝', async () => {
    const { service, card } = makeService({
      title: 'x',
      time: null,
      source: null,
      keyPoints: ['x'],
    });

    await assert.rejects(
      () => service.previewReExtract(card.id, { rawText: '   ' }),
      (error: unknown) => error instanceof ValidationError && error.code === 'EMPTY_TEXT',
    );
    await assert.rejects(
      () => service.previewReExtract(card.id, { rawText: 'x'.repeat(8001) }),
      (error: unknown) => error instanceof ValidationError && error.code === 'TEXT_TOO_LONG',
    );
  });
});

describe('updateCard 与排期对齐', () => {
  it('只改标题也会重算排期（不只时间变了才算）', () => {
    // 卡片存的排期是错的（旧规则算出来的 10-15），时间文本其实一直是 10月22日
    const { repo, service, card } = makeService(
      { title: 'x', time: null, source: null, keyPoints: ['x'] },
      makeCard({
        time: '10月22日',
        schedule: {
          start: '2026-10-15',
          end: '2026-10-15',
          dayCount: 1,
          label: '10月22日',
          inferredYear: true,
        },
      }),
    );

    const updated = service.updateCard(card.id, { title: '改个标题', reason: 'manual' });

    assert.equal(updated?.title, '改个标题');
    assert.equal(
      updated?.schedule?.start,
      '2026-10-22',
      '改标题时排期也要按当前时间文本重算，否则它会一直停在旧值上',
    );
    assert.equal(repo.get(card.id)?.schedule?.start, '2026-10-22');
  });

  it('时间文本改到没有日期的写法时，卡片退出日历', () => {
    const { service, card } = makeService({
      title: 'x',
      time: null,
      source: null,
      keyPoints: ['x'],
    });

    const updated = service.updateCard(card.id, { time: '待定', reason: 'official' });

    assert.equal(updated?.time, '待定');
    assert.equal(updated?.schedule, null);
  });
});
