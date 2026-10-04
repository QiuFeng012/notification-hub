import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createMemoryCardRepository } from '../src/db/sqlite-repository.js';
import { createCardService } from '../src/services/card-service.js';
import type { Summarizer } from '../src/ai/types.js';

const stubSummarizer: Summarizer = {
  summarize() {
    return Promise.resolve({
      draft: {
        title: '选课开放通知',
        time: '2026年9月28日',
        source: '教务处',
        keyPoints: ['要点一'],
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

function pin(app: FastifyInstance, id: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'PUT', url: `/api/cards/${id}/pinned`, payload });
}

describe('PUT /api/cards/:id/pinned', () => {
  it('新建的卡片默认不置顶', async () => {
    const { app, card } = await makeApp();
    assert.equal(card.pinned, false);
    await app.close();
  });

  it('置顶后返回更新后的卡片，列表接口也能读到', async () => {
    const { app, card } = await makeApp();
    const response = await pin(app, card.id, { pinned: true });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().pinned, true);

    const list = (await app.inject({ method: 'GET', url: '/api/cards' })).json();
    assert.equal(list.cards[0].pinned, true);
    await app.close();
  });

  it('可以取消置顶', async () => {
    const { app, card } = await makeApp();
    await pin(app, card.id, { pinned: true });
    const response = await pin(app, card.id, { pinned: false });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().pinned, false);
    await app.close();
  });

  it('置顶不算内容改动：不增加改动次数，也不写改动历史', async () => {
    const { app, card } = await makeApp();
    const updated = (await pin(app, card.id, { pinned: true })).json();

    // 单独开一个接口就是为了这个：置顶不该要求填 reason，
    // 也不该让"已修改 N 次"这个数字变动。
    assert.equal(updated.revisionCount, 0);
    assert.equal(updated.updatedAt, null);

    const revisions = (
      await app.inject({ method: 'GET', url: `/api/cards/${card.id}/revisions` })
    ).json();
    assert.deepEqual(revisions.revisions, []);
    await app.close();
  });

  it('pinned 不是布尔值时报错，而不是静默当作 false', async () => {
    const { app, card } = await makeApp();
    for (const payload of [{}, { pinned: 'true' }, { pinned: 1 }, { pinned: null }]) {
      const response = await pin(app, card.id, payload);
      assert.equal(response.statusCode, 400, `payload=${JSON.stringify(payload)}`);
      assert.equal(response.json().error.code, 'INVALID_BODY');
    }

    const stillUnpinned = (await app.inject({ method: 'GET', url: '/api/cards' })).json();
    assert.equal(stillUnpinned.cards[0].pinned, false, '非法请求不该改动状态');
    await app.close();
  });

  it('卡片不存在时返回 404', async () => {
    const { app } = await makeApp();
    const response = await pin(app, crypto.randomUUID(), { pinned: true });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'CARD_NOT_FOUND');
    await app.close();
  });

  it('ID 不是 UUID 时返回 400，不会把任意字符串丢进 SQL', async () => {
    const { app } = await makeApp();
    const response = await pin(app, 'no-such-card', { pinned: true });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_ID');
    await app.close();
  });

  it('编辑卡片不会把置顶状态清掉', async () => {
    const { app, card } = await makeApp();
    await pin(app, card.id, { pinned: true });

    const edited = (
      await app.inject({
        method: 'PATCH',
        url: `/api/cards/${card.id}`,
        payload: { title: '改过的标题', reason: 'manual' },
      })
    ).json();

    assert.equal(edited.pinned, true);
    await app.close();
  });
});
