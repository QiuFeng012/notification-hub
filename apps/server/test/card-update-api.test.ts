import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.js';
import { createMemoryCardRepository } from '../src/db/sqlite-repository.js';
import { createCardService } from '../src/services/card-service.js';
import type { Summarizer } from '../src/ai/types.js';

/** 固定产出，便于断言改动前后的差异 */
const stubSummarizer: Summarizer = {
  summarize() {
    return Promise.resolve({
      draft: {
        title: '选课开放通知',
        time: '2026年9月28日',
        source: '教务处',
        keyPoints: ['原要点一', '原要点二'],
      },
      provider: 'deepseek' as const,
    });
  },
};

async function makeApp() {
  const repo = createMemoryCardRepository();
  const app = await buildApp({ cardService: createCardService(repo, stubSummarizer) });
  const card = (
    await app.inject({ method: 'POST', url: '/api/cards', payload: { rawText: '【教务处】选课通知。' } })
  ).json();
  return { app, card };
}

describe('PATCH /api/cards/:id', () => {
  it('改标题与要点，返回更新后的卡片', async () => {
    const { app, card } = await makeApp();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/cards/${card.id}`,
      payload: { title: '教务处：选课时间调整', keyPoints: ['改到 3 月 15 日截止'], reason: 'official' },
    });

    assert.equal(response.statusCode, 200);
    const updated = response.json();
    assert.equal(updated.title, '教务处：选课时间调整');
    assert.deepEqual(updated.keyPoints, ['改到 3 月 15 日截止']);
    assert.equal(updated.revisionCount, 1);
    assert.ok(updated.updatedAt);
    await app.close();
  });

  it('未传的字段保持不变', async () => {
    const { app, card } = await makeApp();
    const updated = (
      await app.inject({
        method: 'PATCH',
        url: `/api/cards/${card.id}`,
        payload: { title: '只改标题', reason: 'manual' },
      })
    ).json();

    assert.equal(updated.title, '只改标题');
    assert.equal(updated.source, card.source, '来源不该被动到');
    assert.deepEqual(updated.keyPoints, card.keyPoints, '要点不该被动到');
    await app.close();
  });

  it('缺 reason 时拒绝，因为日后无法追溯为什么与原文不一致', async () => {
    const { app, card } = await makeApp();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/cards/${card.id}`,
      payload: { title: '偷偷改一下' },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_REASON');
    await app.close();
  });

  it('reason 取值非法时同样拒绝', async () => {
    const { app, card } = await makeApp();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/cards/${card.id}`,
      payload: { title: 'x', reason: 'because-i-said-so' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_REASON');
    await app.close();
  });

  it('标题为空被拒绝', async () => {
    const { app, card } = await makeApp();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/cards/${card.id}`,
      payload: { title: '   ', reason: 'manual' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'EMPTY_TITLE');
    await app.close();
  });

  it('要点为空数组被拒绝', async () => {
    const { app, card } = await makeApp();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/cards/${card.id}`,
      payload: { keyPoints: [], reason: 'manual' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'EMPTY_KEY_POINTS');
    await app.close();
  });

  it('要点条数超上限被拒绝', async () => {
    const { app, card } = await makeApp();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/cards/${card.id}`,
      payload: { keyPoints: Array.from({ length: 13 }, (_, i) => `要点${i}`), reason: 'manual' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'TOO_MANY_KEY_POINTS');
    await app.close();
  });

  it('什么都没传时拒绝，而不是造一条空改动记录', async () => {
    const { app, card } = await makeApp();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/cards/${card.id}`,
      payload: { reason: 'manual' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'NOTHING_TO_UPDATE');
    await app.close();
  });

  it('改不存在的卡片返回 404', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/cards/${crypto.randomUUID()}`,
      payload: { title: 'x', reason: 'manual' },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'CARD_NOT_FOUND');
    await app.close();
  });

  it('ID 不是 UUID 时返回 400', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/cards/not-a-uuid',
      payload: { title: 'x', reason: 'manual' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_ID');
    await app.close();
  });

  it('改时间会重算排期', async () => {
    const { app, card } = await makeApp();
    const updated = (
      await app.inject({
        method: 'PATCH',
        url: `/api/cards/${card.id}`,
        payload: { time: '2026年10月5日', reason: 'official', note: '官方推迟' },
      })
    ).json();

    assert.equal(updated.time, '2026年10月5日');
    assert.equal(updated.schedule?.start, '2026-10-05');
    await app.close();
  });

  it('时间可以置为 null，卡片退出日历', async () => {
    const { app, card } = await makeApp();
    const updated = (
      await app.inject({
        method: 'PATCH',
        url: `/api/cards/${card.id}`,
        payload: { time: null, reason: 'manual' },
      })
    ).json();

    assert.equal(updated.time, null);
    assert.equal(updated.schedule, null);
    await app.close();
  });
});

describe('GET /api/cards/:id/revisions', () => {
  it('没改过时返回空列表', async () => {
    const { app, card } = await makeApp();
    const response = await app.inject({ method: 'GET', url: `/api/cards/${card.id}/revisions` });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().revisions, []);
    await app.close();
  });

  it('记录改动前的内容与原因', async () => {
    const { app, card } = await makeApp();
    await app.inject({
      method: 'PATCH',
      url: `/api/cards/${card.id}`,
      payload: { title: '新标题', reason: 'official', note: '教务处改了截止时间' },
    });

    const response = await app.inject({ method: 'GET', url: `/api/cards/${card.id}/revisions` });
    const revisions = response.json().revisions;
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].previousTitle, '选课开放通知');
    assert.equal(revisions[0].previousTime, '2026年9月28日');
    assert.deepEqual(revisions[0].previousKeyPoints, ['原要点一', '原要点二']);
    assert.equal(revisions[0].reason, 'official');
    assert.equal(revisions[0].note, '教务处改了截止时间');
    await app.close();
  });

  it('卡片不存在时返回 404，而不是空列表', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: `/api/cards/${crypto.randomUUID()}/revisions`,
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'CARD_NOT_FOUND');
    await app.close();
  });

  it('多次改动按时间倒序返回', async () => {
    const { app, card } = await makeApp();
    await app.inject({
      method: 'PATCH',
      url: `/api/cards/${card.id}`,
      payload: { title: '第二版', reason: 'manual' },
    });
    await app.inject({
      method: 'PATCH',
      url: `/api/cards/${card.id}`,
      payload: { title: '第三版', reason: 'official' },
    });

    const revisions = (await app.inject({ method: 'GET', url: `/api/cards/${card.id}/revisions` })).json()
      .revisions;
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0].previousTitle, '第二版');
    assert.equal(revisions[1].previousTitle, '选课开放通知');
    await app.close();
  });

  it('列表接口返回的卡片带 revisionCount 与 updatedAt', async () => {
    const { app, card } = await makeApp();
    await app.inject({
      method: 'PATCH',
      url: `/api/cards/${card.id}`,
      payload: { title: '改过', reason: 'manual' },
    });

    const list = (await app.inject({ method: 'GET', url: '/api/cards' })).json();
    assert.equal(list.cards[0].revisionCount, 1);
    assert.ok(list.cards[0].updatedAt);
    await app.close();
  });

  it('新建的卡片 revisionCount 为 0、updatedAt 为 null', async () => {
    const { app, card } = await makeApp();
    assert.equal(card.revisionCount, 0);
    assert.equal(card.updatedAt, null);
    await app.close();
  });
});

describe('DELETE /api/cards/:id/revisions', () => {
  it('清空历史并把次数归零，卡片内容不受影响', async () => {
    const { app, card } = await makeApp();
    await app.inject({
      method: 'PATCH',
      url: `/api/cards/${card.id}`,
      payload: { title: '改过一版', reason: 'official' },
    });

    const response = await app.inject({ method: 'DELETE', url: `/api/cards/${card.id}/revisions` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().removed, 1);

    const after = (await app.inject({ method: 'GET', url: '/api/cards' })).json().cards[0];
    assert.equal(after.revisionCount, 0);
    assert.equal(after.title, '改过一版', '清历史不该动内容');
    assert.deepEqual(
      (await app.inject({ method: 'GET', url: `/api/cards/${card.id}/revisions` })).json().revisions,
      [],
    );
    await app.close();
  });

  it('卡片不存在时返回 404', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/cards/${crypto.randomUUID()}/revisions`,
    });
    assert.equal(response.statusCode, 404);
    await app.close();
  });

  it('没有历史时清空是幂等的，removed 为 0', async () => {
    const { app, card } = await makeApp();
    const response = await app.inject({ method: 'DELETE', url: `/api/cards/${card.id}/revisions` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().removed, 0);
    await app.close();
  });
});

/**
 * 用户实际报的缺陷：改动完信息的时间后，日历里没有同步。
 * 示例就是「本学期第一次宿舍内务卫生检查通知」——原文把日期和时刻分成两行，
 * 卡片的时间字段写着「10月22号（第八周周四）14:30-17:30」，
 * 但日历上的那条既没有 14:30-17:30，改到 10-29 之后旧日期也还留在日历上。
 */
describe('PATCH /api/cards/:id：时间改动同步到日历', () => {
  const RAW = [
    '⏰检查时间：',
    '10月22号（第八周周四）',
    '14：30-17:30',
    '请于10月20号（下周二）16：00前交表。',
  ].join('\n');

  /** 固定产出：模拟创建这张卡时模型提炼出来的时间 */
  const dormSummarizer: Summarizer = {
    summarize() {
      return Promise.resolve({
        draft: {
          title: '本学期第一次宿舍内务卫生检查通知',
          time: '10月22号（第八周周四）14:30-17:30',
          source: '学生自律委员会',
          keyPoints: ['检查时间为10月22号（第八周周四）14:30-17:30'],
        },
        provider: 'mock' as const,
      });
    },
  };

  async function makeDormApp() {
    const repo = createMemoryCardRepository();
    const app = await buildApp({
      cardService: createCardService(repo, dormSummarizer, {
        // 固定锚点，日期推断结果才不跟着运行时间漂
        now: () => new Date('2026-10-13T04:18:03.869Z'),
      }),
    });
    const card = (
      await app.inject({ method: 'POST', url: '/api/cards', payload: { rawText: RAW } })
    ).json();
    return { app, card };
  }

  it('新建时就把时间字段里的起止时刻补进主日程', async () => {
    const { app, card } = await makeDormApp();

    assert.equal(card.schedule?.start, '2026-10-22');
    assert.equal(card.schedule?.startTime, '14:30');
    assert.equal(card.schedule?.endTime, '17:30');
    await app.close();
  });

  it('改到新日期后旧日期从日历上消失，新日期成为主日程', async () => {
    const { app, card } = await makeDormApp();
    const updated = (
      await app.inject({
        method: 'PATCH',
        url: `/api/cards/${card.id}`,
        payload: { time: '10月29号（第九周周四）14:30-18:30', reason: 'official' },
      })
    ).json();

    assert.deepEqual(
      updated.schedules.map((item: { start: string }) => item.start).sort(),
      ['2026-10-20', '2026-10-29'],
      `旧日期应被新日期取代，实际 ${JSON.stringify(updated.schedules)}`,
    );
    assert.equal(updated.schedule?.start, '2026-10-29');
    assert.equal(updated.schedule?.startTime, '14:30');
    assert.equal(updated.schedule?.endTime, '18:30');
    await app.close();
  });

  it('只改当天时刻时，主日程的起止时刻跟着同步', async () => {
    const { app, card } = await makeDormApp();
    const updated = (
      await app.inject({
        method: 'PATCH',
        url: `/api/cards/${card.id}`,
        payload: { time: '10月22号（第八周周四）15:00-18:00', reason: 'official' },
      })
    ).json();

    assert.equal(updated.schedule?.start, '2026-10-22');
    assert.equal(updated.schedule?.startTime, '15:00');
    assert.equal(updated.schedule?.endTime, '18:00');
    await app.close();
  });
});
