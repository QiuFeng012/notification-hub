import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { MAX_RAW_TEXT_LENGTH } from '@notification-hub/shared';
import { buildApp } from '../src/app.js';
import { createMemoryCardRepository } from '../src/db/sqlite-repository.js';
import { createCardService, ValidationError } from '../src/services/card-service.js';
import { createSettingsService } from '../src/services/settings-service.js';
import { createSettingsStore } from '../src/settings/settings-store.js';
import type { Summarizer } from '../src/ai/types.js';

/** 确定性摘要器：不需要联网，产出固定内容，便于断言接口行为 */
const stubSummarizer: Summarizer = {
  summarize() {
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

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 建一个隔离的设置服务，避免测试互相污染，也不碰真实的 data/settings.json */
function makeSettingsService(envApiKey: string | null = null) {
  const dir = mkdtempSync(path.join(tmpdir(), 'notification-hub-api-'));
  tempDirs.push(dir);
  const store = createSettingsStore({
    filePath: path.join(dir, 'settings.json'),
    envApiKey,
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
  });
  return createSettingsService({
    store,
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    // 让"验证 Key"这一步在测试里确定性地成功，不真的联网
    fetchImpl: (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"t","key_points":["a"]}' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch,
  });
}

async function makeApp(summarizer: Summarizer = stubSummarizer, envApiKey: string | null = null) {
  const repo = createMemoryCardRepository();
  const app = await buildApp({
    cardService: createCardService(repo, summarizer),
    settingsService: makeSettingsService(envApiKey),
  });
  return { app, repo };
}

async function createCard(app: Awaited<ReturnType<typeof makeApp>>['app'], rawText: string) {
  return app.inject({ method: 'POST', url: '/api/cards', payload: { rawText } });
}

async function createCardWithKeywords(
  app: Awaited<ReturnType<typeof makeApp>>['app'],
  rawText: string,
  keywords: unknown,
) {
  return app.inject({ method: 'POST', url: '/api/cards', payload: { rawText, keywords } });
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

  it('不带 Content-Type 的 DELETE 正常删除（前端实际发出的形态）', async () => {
    const { app } = await makeApp();
    const card = (await createCard(app, '待删除通知')).json();

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/cards/${card.id}`,
      headers: {},
    });
    assert.equal(response.statusCode, 200);
    await app.close();
  });

  // 契约测试：这曾经是删除失败的根因。前端给无 body 的 DELETE 加了
  // Content-Type: application/json，请求在进入路由前就被解析器拒绝。
  // 断言服务端这个行为是有意为之的，避免有人"顺手"放宽后前端再踩坑。
  it('声明 application/json 却不带 body 的 DELETE 会被解析器拒绝', async () => {
    const { app } = await makeApp();
    const card = (await createCard(app, '待删除通知')).json();

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/cards/${card.id}`,
      headers: { 'content-type': 'application/json' },
    });

    assert.ok(
      response.statusCode >= 400 && response.statusCode < 500,
      `应为 4xx，实际 ${response.statusCode}`,
    );
    // 卡片必须还在，说明请求没到业务逻辑
    const body = (await app.inject({ method: 'GET', url: '/api/cards' })).json();
    assert.equal(body.total, 1);
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

describe('POST /api/cards 的关注点', () => {
  it('不传 keywords 时记录为空', async () => {
    const { app } = await makeApp();
    const card = (await createCard(app, '【教务处】选课通知。')).json();
    assert.deepEqual(card.keywords, { priority: [], hit: [], missed: [] });
    await app.close();
  });

  it('keywords 会归一化后记录在卡片上', async () => {
    const { app } = await makeApp();
    const card = (await createCardWithKeywords(app, '【教务处】选课通知。', ' 面试 ，报销, 面试 ')).json();

    assert.deepEqual(card.keywords.priority, ['面试', '报销']);
    await app.close();
  });

  it('模型漏掉原文提到的关注点时，由服务端补入证据要点', async () => {
    const { app } = await makeApp();
    const rawText = '会议时间改到周五。报销材料请交到财务处。';
    // stub 摘要器只会产出固定的两条要点，都不含"报销"
    const card = (await createCardWithKeywords(app, rawText, ['报销'])).json();

    assert.deepEqual(card.keywords.missed, ['报销']);
    assert.ok(
      card.keyPoints.some((point: string) => point.includes('报销材料请交到财务处')),
      `兜底要点应包含原文证据句，实际：${JSON.stringify(card.keyPoints)}`,
    );
    await app.close();
  });

  it('要点已覆盖关注点时不会重复补入', async () => {
    const { app } = await makeApp();
    const card = (await createCardWithKeywords(app, '3月8日24:00前完成。', ['3月8日'])).json();

    assert.deepEqual(card.keywords.hit, ['3月8日']);
    assert.deepEqual(card.keywords.missed, []);
    await app.close();
  });

  it('keywords 传非法类型时不报错，按没有关注点处理', async () => {
    const { app } = await makeApp();
    const response = await createCardWithKeywords(app, '【教务处】选课通知。', 12345);
    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.json().keywords, { priority: [], hit: [], missed: [] });
    await app.close();
  });

  it('关注点随卡片一起持久化，列表里也能读到', async () => {
    const { app } = await makeApp();
    await createCardWithKeywords(app, '关于报销的通知。', ['报销']);

    const list = (await app.inject({ method: 'GET', url: '/api/cards' })).json();
    assert.deepEqual(list.cards[0].keywords.priority, ['报销']);
    assert.ok(Array.isArray(list.cards[0].keywords.hit));
    await app.close();
  });
});

describe('GET /api/settings', () => {
  it('未配置时返回 mock 与默认地址', async () => {
    const { app } = await makeApp();
    const body = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    assert.equal(body.configured, false);
    assert.equal(body.source, 'mock');
    assert.equal(body.apiKeyMask, null);
    assert.equal(body.baseUrl, 'https://api.deepseek.com');
    await app.close();
  });

  it('来自环境变量时 source 为 env', async () => {
    const { app } = await makeApp(stubSummarizer, 'sk-from-env-1234567890');
    const body = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    assert.equal(body.configured, true);
    assert.equal(body.source, 'env');
    await app.close();
  });

  // 安全断言：完整密钥绝不能出现在接口响应里
  it('响应里只有掩码，绝不含完整 Key', async () => {
    const { app } = await makeApp();
    const secret = 'sk-super-secret-value-0001';
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: secret } });

    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    assert.ok(!response.body.includes(secret), '响应体不应包含完整 Key');
    const body = response.json();
    assert.equal(body.source, 'user');
    assert.equal(body.configured, true);
    assert.match(body.apiKeyMask, /^sk-sup/);
    assert.ok(body.apiKeyMask.includes('…'));
    await app.close();
  });
});

describe('PUT /api/settings', () => {
  it('保存合法 Key 后配置生效', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { apiKey: 'sk-valid-key-abcdefg' },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.settings.configured, true);
    assert.equal(body.settings.source, 'user');
    assert.equal(body.warning, null);
    await app.close();
  });

  it('可以只改 baseUrl 与模型名', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { baseUrl: 'https://proxy.example.com/v1', model: 'deepseek-reasoner' },
    });

    const body = response.json();
    assert.equal(body.settings.baseUrl, 'https://proxy.example.com/v1');
    assert.equal(body.settings.model, 'deepseek-reasoner');
    // 没有 Key 时仍然是 mock 模式
    assert.equal(body.settings.source, 'mock');
    await app.close();
  });

  it('apiKey 传空字符串表示清除已保存的 Key', async () => {
    const { app } = await makeApp();
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: 'sk-first-key-123456' } });
    assert.equal((await app.inject({ method: 'GET', url: '/api/settings' })).json().configured, true);

    const response = await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: '' } });
    assert.equal(response.json().settings.configured, false);
    await app.close();
  });

  it('字段类型不对返回 400 INVALID_BODY', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: 123 } });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_BODY');
    await app.close();
  });

  it('Key 过长返回 400 VALUE_TOO_LONG', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { apiKey: 'x'.repeat(201) },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'VALUE_TOO_LONG');
    await app.close();
  });
});

describe('DELETE /api/settings', () => {
  it('清除后回落到未配置状态', async () => {
    const { app } = await makeApp();
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: 'sk-to-be-cleared-1234' } });

    const response = await app.inject({ method: 'DELETE', url: '/api/settings' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().configured, false);
    await app.close();
  });

  it('有环境变量 Key 时，清除用户配置后回落到 env', async () => {
    const { app } = await makeApp(stubSummarizer, 'sk-env-fallback-5678');
    await app.inject({ method: 'PUT', url: '/api/settings', payload: { apiKey: 'sk-user-override-9999' } });
    assert.equal((await app.inject({ method: 'GET', url: '/api/settings' })).json().source, 'user');

    await app.inject({ method: 'DELETE', url: '/api/settings' });
    const body = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    assert.equal(body.source, 'env');
    assert.equal(body.configured, true);
    await app.close();
  });
});
