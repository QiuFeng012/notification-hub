import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createCardApi } from '../src/lib/api';

const SERVER_CARD = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  title: '选课开放通知',
  time: '3月8日24:00前',
  source: '教务处',
  keyPoints: ['3月5日14:00开放选课'],
  rawText: '【教务处】原文',
  provider: 'deepseek',
  createdAt: '2025-03-05T06:32:00.000Z',
};

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createCardApi.listCards', () => {
  it('解析服务端返回的卡片列表', async () => {
    mockFetch(() => jsonResponse({ cards: [SERVER_CARD], total: 1 }));
    const cards = await createCardApi().listCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]?.title).toBe('选课开放通知');
  });

  it('过滤掉结构不合法的条目而不是整体失败', async () => {
    mockFetch(() => jsonResponse({ cards: [SERVER_CARD, { title: '缺少 id' }, null], total: 3 }));
    const cards = await createCardApi().listCards();
    expect(cards).toHaveLength(1);
  });

  it('响应缺少 cards 字段时返回空数组', async () => {
    mockFetch(() => jsonResponse({ total: 0 }));
    await expect(createCardApi().listCards()).resolves.toEqual([]);
  });

  it('请求路径为 /api/cards', async () => {
    const spy = mockFetch(() => jsonResponse({ cards: [], total: 0 }));
    await createCardApi().listCards();
    expect(spy.mock.calls[0]?.[0]).toBe('/api/cards');
  });
});

describe('createCardApi.createCard', () => {
  it('POST 原文并返回生成的卡片', async () => {
    const spy = mockFetch(() => jsonResponse(SERVER_CARD, 201));
    const card = await createCardApi().createCard('通知原文');

    expect(card.id).toBe(SERVER_CARD.id);
    const [url, init] = spy.mock.calls[0] ?? [];
    expect(url).toBe('/api/cards');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ rawText: '通知原文' });
  });

  it('带 body 的请求声明 application/json', async () => {
    const spy = mockFetch(() => jsonResponse(SERVER_CARD, 201));
    await createCardApi().createCard('通知原文');

    const headers = (spy.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('服务端返回结构不对时抛出 INVALID_RESPONSE', async () => {
    mockFetch(() => jsonResponse({ title: '缺少 id' }, 201));
    await expect(createCardApi().createCard('通知')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('把服务端错误信封翻译成 ApiError', async () => {
    mockFetch(() => jsonResponse({ error: { code: 'EMPTY_TEXT', message: '通知内容不能为空' } }, 400));

    await expect(createCardApi().createCard('   ')).rejects.toMatchObject({
      code: 'EMPTY_TEXT',
      message: '通知内容不能为空',
      status: 400,
    });
  });

  it('没有错误信封时给出通用提示', async () => {
    mockFetch(() => new Response('<html>502</html>', { status: 502 }));
    const error = await createCardApi()
      .createCard('通知')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain('502');
  });
});

describe('createCardApi 网络层', () => {
  it('fetch 直接抛错时提示检查本地服务', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    await expect(createCardApi().listCards()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});

describe('createCardApi.deleteCard', () => {
  it('对指定 id 发 DELETE 请求', async () => {
    const spy = mockFetch(() => new Response(null, { status: 200 }));
    await createCardApi().deleteCard(SERVER_CARD.id);

    const [url, init] = spy.mock.calls[0] ?? [];
    expect(url).toBe(`/api/cards/${SERVER_CARD.id}`);
    expect(init?.method).toBe('DELETE');
  });

  // 回归测试：曾经无条件加 Content-Type，而 DELETE 没有 body，
  // Fastify 会直接以 FST_ERR_CTP_EMPTY_JSON_BODY 拒绝，导致删除功能完全不可用。
  it('DELETE 不带 Content-Type，也不带 body', async () => {
    const spy = mockFetch(() => new Response(null, { status: 200 }));
    await createCardApi().deleteCard(SERVER_CARD.id);

    const init = spy.mock.calls[0]?.[1];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['Content-Type']).toBeUndefined();
    expect(init?.body).toBeUndefined();
  });

  it('404 时抛出 CARD_NOT_FOUND', async () => {
    mockFetch(() => jsonResponse({ error: { code: 'CARD_NOT_FOUND', message: '信息卡不存在' } }, 404));
    await expect(createCardApi().deleteCard('missing')).rejects.toMatchObject({
      code: 'CARD_NOT_FOUND',
    });
  });
});
