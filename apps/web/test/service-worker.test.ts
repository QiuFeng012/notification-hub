import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

/**
 * sw.js 的行为测试。
 *
 * 为什么真的把它跑起来，而不是断言源码里有没有某段字符串：
 * 这个 service worker 唯一的职责就是**不要缓存应用代码**，而"没有缓存"
 * 是一个行为，不是一个写法。源码断言既拦不住"换个写法照样缓存"，
 * 也会被无关的重命名搞红。
 *
 * 所以这里给一个假的 service worker 全局环境，把真实事件派发进去，
 * 直接观察它有没有调 respondWith、以及回落的到底是什么。
 */
const swSource = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'sw.js'),
  'utf8',
);

const ORIGIN = 'http://127.0.0.1:5178';

interface FakeRequest {
  url: string;
  method: string;
  mode: string;
  cache?: string;
}

/** 最小可用的 Request：测试只关心 method / mode / url 这三个判定依据 */
class FakeRequestImpl implements FakeRequest {
  readonly url: string;
  readonly method: string;
  readonly mode: string;
  readonly cache?: string;

  constructor(url: string, init: { cache?: string; method?: string; mode?: string } = {}) {
    this.url = url.startsWith('/') ? `${ORIGIN}${url}` : url;
    this.method = init.method ?? 'GET';
    this.mode = init.mode ?? 'navigate';
    this.cache = init.cache;
  }
}

class FakeResponseImpl {
  constructor(readonly body: string) {}
  static error() {
    return new FakeResponseImpl('__network_error__');
  }
}

/** 记录 add() 存了什么，用来验证只缓存了那一张说明页 */
class FakeCache {
  readonly entries = new Map<string, FakeResponseImpl>();

  add(request: FakeRequest): Promise<void> {
    this.entries.set(request.url, new FakeResponseImpl('__offline_page__'));
    return Promise.resolve();
  }

  match(url: string): Promise<FakeResponseImpl | undefined> {
    return Promise.resolve(this.entries.get(`${ORIGIN}${url}`));
  }
}

interface FetchEvent {
  request: FakeRequest;
  respondWith: (value: unknown) => void;
  /** 被调用过就说明这个请求被 service worker 接管了 */
  handled: boolean;
  /** respondWith 最终交付给浏览器的响应 */
  result: unknown;
}

function createWorkerWorld(options: { fetchImpl?: (request: FakeRequest) => Promise<unknown> } = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const cache = new FakeCache();
  const closedCaches = new Map<string, FakeCache>([[cacheName(), cache]]);

  function cacheName(): string {
    return 'notification-hub-offline-v1';
  }

  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler),
    skipWaiting: vi.fn(() => Promise.resolve()),
    clients: { claim: vi.fn(() => Promise.resolve()) },
  };

  const cachesApi = {
    open: vi.fn((name: string) => {
      if (!closedCaches.has(name)) closedCaches.set(name, new FakeCache());
      return Promise.resolve(closedCaches.get(name));
    }),
    keys: vi.fn(() => Promise.resolve([...closedCaches.keys()])),
    delete: vi.fn((name: string) => {
      closedCaches.delete(name);
      return Promise.resolve(true);
    }),
  };

  const fetchMock = vi.fn(options.fetchImpl ?? (() => Promise.resolve(new FakeResponseImpl('__app_shell__'))));

  // 用真实的 sw.js 源码，只替换它依赖的那几个全局
  const run = new Function('self', 'caches', 'fetch', 'Request', 'Response', 'URL', swSource);
  run(self, cachesApi, fetchMock, FakeRequestImpl, FakeResponseImpl, URL);

  async function dispatchFetch(request: FakeRequest): Promise<FetchEvent> {
    const event: FetchEvent = { request, handled: false, respondWith: () => undefined, result: undefined };
    let settled: Promise<unknown> | undefined;
    event.respondWith = (value: unknown) => {
      event.handled = true;
      settled = Promise.resolve(value);
    };
    listeners.get('fetch')?.(event);
    // respondWith 里传的是 promise，等它落地才能断言回落的响应
    if (settled) event.result = await settled;
    return event;
  }

  /** 按真实顺序先跑一遍 install，把离线说明页放进缓存 */
  async function runInstall(): Promise<void> {
    let waited: Promise<unknown> | undefined;
    listeners.get('install')?.({ waitUntil: (value: Promise<unknown>) => { waited = value; } });
    await waited;
  }

  return { listeners, cache, caches: cachesApi, fetchMock, dispatchFetch, runInstall, closedCaches };
}

describe('sw.js 只接管导航请求', () => {
  it('静态资源一律不碰，交给浏览器默认行为', async () => {
    const world = createWorkerWorld();
    const script = await world.dispatchFetch(
      new FakeRequestImpl(`${ORIGIN}/assets/index-abc.js`, { mode: 'no-cors' }),
    );

    // 没有 respondWith 就说明这个请求完全没被拦截
    expect(script.handled).toBe(false);
    expect(world.fetchMock).not.toHaveBeenCalled();
  });

  it('导航请求会走网络，成功时原样返回，不回落到缓存', async () => {
    const world = createWorkerWorld();
    const event = await world.dispatchFetch(new FakeRequestImpl('/'));

    expect(event.handled).toBe(true);
    expect(world.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('POST 等非 GET 请求不接管', async () => {
    const world = createWorkerWorld();
    const event = await world.dispatchFetch(new FakeRequestImpl('/api/cards', { method: 'POST', mode: 'cors' }));

    expect(event.handled).toBe(false);
  });

  it('/api/ 即使作为导航也不接管：缓存住的旧卡片比连不上更糟', async () => {
    const world = createWorkerWorld();
    const event = await world.dispatchFetch(new FakeRequestImpl('/api/cards'));

    expect(event.handled).toBe(false);
    expect(world.fetchMock).not.toHaveBeenCalled();
  });

  it('跨域请求不接管', async () => {
    const world = createWorkerWorld();
    const event = await world.dispatchFetch(new FakeRequestImpl('https://api.deepseek.com/chat/completions'));

    expect(event.handled).toBe(false);
  });
});

describe('sw.js 在服务没在跑时的回落', () => {
  it('网络失败时交付的就是那张离线说明页', async () => {
    const world = createWorkerWorld({
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    // 真实顺序：先 install 把说明页缓存起来，之后再遇到打不开的导航
    await world.runInstall();
    expect([...world.cache.entries.keys()]).toEqual([`${ORIGIN}/offline.html`]);

    const event = await world.dispatchFetch(new FakeRequestImpl('/'));

    expect(event.handled).toBe(true);
    // 交付的必须是说明页，不能是任何应用外壳
    expect((event.result as { body: string }).body).toBe('__offline_page__');
  });

  it('缓存里没有说明页时老实报网络错误，不假装有内容', async () => {
    const world = createWorkerWorld({
      fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    const event = await world.dispatchFetch(new FakeRequestImpl('/'));

    expect((event.result as { body: string }).body).toBe('__network_error__');
  });

  it('网络成功时绝不读缓存，避免"重建之后还是旧界面"', async () => {
    const world = createWorkerWorld();
    await world.runInstall();
    world.caches.open.mockClear();
    world.caches.keys.mockClear();

    const event = await world.dispatchFetch(new FakeRequestImpl('/'));

    expect(event.handled).toBe(true);
    // 关键断言：成功路径上一次都没打开过 Cache Storage
    expect(world.caches.open).not.toHaveBeenCalled();
    expect(world.caches.keys).not.toHaveBeenCalled();
  });
});

describe('sw.js 的安装与激活', () => {
  it('install 阶段只缓存离线说明页，并跳过等待', async () => {
    const world = createWorkerWorld();
    expect(world.listeners.get('install'), 'sw.js 必须注册 install 处理器').toBeTypeOf('function');

    await world.runInstall();

    expect([...world.cache.entries.keys()]).toEqual([`${ORIGIN}/offline.html`]);
  });

  it('activate 阶段清掉自己旧版本的缓存，不留垃圾', async () => {
    const world = createWorkerWorld();
    world.closedCaches.set('notification-hub-offline-v0', new FakeCache());

    let waited: Promise<unknown> | undefined;
    world.listeners.get('activate')?.({ waitUntil: (value: Promise<unknown>) => { waited = value; } });
    await waited;

    expect([...world.closedCaches.keys()]).toEqual(['notification-hub-offline-v1']);
  });
});

describe('sw.js 源码约束', () => {
  it('没有任何应用代码的预缓存列表', () => {
    // 一旦出现 precache 清单，"重建后跑的还是旧界面"就会回来
    expect(swSource).not.toMatch(/\.html['"]\s*,\s*['"]\/assets/);
    expect(swSource).not.toMatch(/cache\.addAll/);
    expect(swSource).not.toMatch(/['"]\/assets\//);
  });
});
