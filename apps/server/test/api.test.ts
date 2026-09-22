import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_RAW_TEXT_LENGTH } from '@notification-hub/shared';
import { buildApp } from '../src/app.js';
import { createMemoryCardRepository } from '../src/db/sqlite-repository.js';
import { createCardService, ValidationError } from '../src/services/card-service.js';
import type { Summarizer } from '../src/ai/types.js';

/** 确定性摘要器：不需要联网，产出固定内容，便于断言接口行为 */
const stubSummarizer: Summarizer = {
  summarize(rawText: string) {
    return Promise.resolve({
      draft: {
        title: '选课开放通知',
        time: '3月8日24:00前',
        source: '教务处',
        keyPoints: ['3月5日14:00开放选课', '3月8日24:00前完成'],
      },
      provider: 'deepseek' as const,
    });
  },
};

const failingSummarizer: Summarizer = {
  summarize() {
    return Promise.reject(new Error('上游模型炸了'));
  },
};

async function makeApp(summarizer: Summarizer = stubSummarizer) {
  const repo = createMemoryCardRepository();
  const app = await buildApp({ cardService: createCardService(repo, summarizer) });
  return { app, repo };
}

async function createCard(app: Awaited<ReturnType<typeof makeApp>>['app'], rawText: string) {
  return app.inject({ method: 'POST', url: '/api/cards', payload: { rawText } });
}

describe('GET /api/health', () => {
  it('返回 ok', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
    await app.close();
  });
});

describe('POST /api/cards', () => {
  it('生成信息卡并返回 201，字段完整', async () => {
    const { app } = await makeApp();
    const response = await createCard(app, '【教务处】选课通知：3月5日14:00开放。');

    assert.equal(response.statusCode, 201);
    const card = response.json();
    assert.match(card.id, /^[0-9a-f-]{36}$/);
    assert.equal(card.title, '选课开放通知');
    assert.equal(card.source, '教务处');
    assert.deepEqual(card.keyPoints, ['3月5日14:00开放选课', '3月8日24:00前完成']);
    assert.equal(card.rawText, '【教务处】选课通知：3月5日14:00开放。');
    assert.equal(card.provider, 'deepseek');
    assert.ok(!Number.isNaN(Date.parse(card.createdAt)));
    await app.close();
  });

  it('原文首尾空白被裁剪后入库', async () => {
    const { app } = await makeApp();
    const response = await createCard(app, '   前后都有空格   ');
    assert.equal(response.json().rawText, '前后都有空格');
    await app.close();
  });

  it('空内容返回 400 EMPTY_TEXT', async () => {
    const { app } = await makeApp();
    const response = await createCard(app, '   \n  ');
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'EMPTY_TEXT');
    await app.close();
  });

  it('rawText 非字符串返回 400 INVALID_BODY', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'POST', url: '/api/cards', payload: { rawText: 123 } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_BODY');
    await app.close();
  });

  it('缺少请求体返回 400 INVALID_BODY', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'POST', url: '/api/cards', payload: {} });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_BODY');
    await app.close();
  });

  it('超长内容返回 413 TEXT_TOO_LONG', async () => {
    const { app } = await makeApp();
    const response = await createCard(app, '字'.repeat(MAX_RAW_TEXT_LENGTH + 1));
    assert.equal(response.statusCode, 413);
    assert.equal(response.json().error.code, 'TEXT_TOO_LONG');
    await app.close();
  });

  it('恰好等于上限的内容可以处理', async () => {
    const { app } = await makeApp();
    const response = await createCard(app, '字'.repeat(MAX_RAW_TEXT_LENGTH));
    assert.equal(response.statusCode, 201);
    await app.close();
  });

  it('摘要器抛非预期异常时返回 500 且不泄露堆栈', async () => {
    const { app } = await makeApp(failingSummarizer);
    const response = await createCard(app, '正常内容');
    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(response.json()).includes('上游模型炸了'));
    await app.close();
  });
});

describe('GET /api/cards', () => {
  it('初始为空', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/cards' });
    assert.deepEqual(response.json(), { cards: [], total: 0 });
    await app.close();
  });

  it('新生成的卡片排在最前，total 正确', async () => {
    const { app } = await makeApp();
    const first = (await createCard(app, '第一条通知')).json();
    const second = (await createCard(app, '第二条通知')).json();

    const body = (await app.inject({ method: 'GET', url: '/api/cards' })).json();
    assert.equal(body.total, 2);
    assert.equal(body.cards.length, 2);
    assert.equal(body.cards[0].id, second.id);
    assert.equal(body.cards[1].id, first.id);
    await app.close();
  });
});

describe('DELETE /api/cards/:id', () => {
  it('删除成功返回被删掉的卡片', async () => {
    const { app } = await makeApp();
    const card = (await createCard(app, '待删除通知')).json();

    const response = await app.inject({ method: 'DELETE', url: `/api/cards/${card.id}` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().id, card.id);

    const body = (await app.inject({ method: 'GET', url: '/api/cards' })).json();
    assert.equal(body.total, 0);
    await app.close();
  });

  it('删除不存在的卡片返回 404', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/cards/${crypto.randomUUID()}`,
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'CARD_NOT_FOUND');
    await app.close();
  });

  it('ID 不是 UUID 时返回 400 INVALID_ID', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'DELETE', url: '/api/cards/not-a-uuid' });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_ID');
    await app.close();
  });
});

describe('未注册的接口', () => {
  it('返回 404 而不是 HTML', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(response.statusCode, 404);
    await app.close();
  });
});

describe('createCardService 参数校验', () => {
  it('非法 rawText 抛出 ValidationError 并带错误码', async () => {
    const service = createCardService(createMemoryCardRepository(), stubSummarizer);
    await assert.rejects(
      () => service.createCard({ rawText: null }),
      (error: unknown) => error instanceof ValidationError && error.code === 'INVALID_BODY',
    );
  });
});
