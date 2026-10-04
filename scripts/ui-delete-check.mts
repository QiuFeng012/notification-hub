/**
 * 界面真实交互验证：用 Chrome DevTools Protocol 驱动无头浏览器，真实点击界面按钮。
 *
 * 覆盖三条只有真跑才能确认的路径：
 *   1. 提交原文后新卡片真的出现在界面上；
 *   2. 置顶后卡片真的排到最前，并且状态真的写进了服务端；
 *   3. 删除后卡片真的从界面和服务端一起消失。
 *
 * 第 3 步尤其重要：删除走的是无 body 的 DELETE，曾经因为多带了一个
 * Content-Type 头被 Fastify 以 FST_ERR_CTP_EMPTY_JSON_BODY 拒绝，
 * 而单元测试里的 mock 不校验请求头，完全没拦住。
 *
 * 用法：先启动服务端，再执行
 *   npx tsx scripts/ui-delete-check.mts [appUrl] [cdpPort]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appUrl = (process.argv[2] ?? 'http://127.0.0.1:5178').replace(/\/+$/, '');
const cdpPort = Number(process.argv[3] ?? 9222);

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const browserPath = EDGE_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!browserPath) {
  console.error('找不到可用的 Chromium 内核浏览器，跳过界面验证');
  process.exit(2);
}

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  process.exitCode = 1;
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-hub-ui-'));
const browser = spawn(
  browserPath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPageTarget(): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = (await response.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // 浏览器还没起来，继续等
    }
    await sleep(250);
  }
  throw new Error('无法连接到浏览器调试端口');
}

interface CdpMessage {
  id?: number;
  result?: { result?: { value?: unknown } };
  error?: { message: string };
}
/** 极简 CDP 客户端：只需要 Runtime.evaluate */
function createCdp(wsUrl: string) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map<number, (message: CdpMessage) => void>();
  let nextId = 1;

  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (typeof message.id === 'number') {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  return {
    ready,
    /** 任意 CDP 命令；用来在文档创建前注入脚本 */
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const id = nextId;
      nextId += 1;
      const promise = new Promise<CdpMessage>((resolve) => pending.set(id, resolve));
      socket.send(JSON.stringify({ id, method, params }));
      const message = await promise;
      if (message.error) throw new Error(`${method}: ${message.error.message}`);
      return message.result as unknown as T;
    },
    async evaluate<T>(expression: string): Promise<T> {
      const id = nextId;
      nextId += 1;
      const promise = new Promise<CdpMessage>((resolve) => pending.set(id, resolve));
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
      const message = await promise;
      if (message.error) throw new Error(message.error.message);
      const result = message.result?.result;
      if (result && typeof result === 'object' && 'value' in result) {
        return result.value as T;
      }
      return undefined as T;
    },
    close() {
      socket.close();
    },
  };
}

/** 同一进程内的轮询 helper，注入到页面里等待条件成立 */
const POLL_HELPER = `
window.__waitFor = async (predicate, timeoutMs = 8000) => {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
`;

async function main(): Promise<void> {
  console.log(`界面验证目标：${appUrl}`);
  console.log(`浏览器：${browserPath}\n`);

  const cdp = createCdp(await findPageTarget());
  await cdp.ready;

  await cdp.evaluate(`location.href = ${JSON.stringify(appUrl)}`);
  await sleep(1500);
  await cdp.evaluate(POLL_HELPER);

  const cardCount = () =>
    cdp.evaluate<number>(`document.querySelectorAll('[data-testid="info-card"]').length`);
  const cardIds = () =>
    cdp.evaluate<string[]>(
      `[...document.querySelectorAll('[data-testid="info-card"]')].map((el) => el.dataset.cardId)`,
    );
  /** 点页头右上角的导航按钮；返回是否找到了那个按钮 */
  const clickNav = (text: string) =>
    cdp.evaluate<boolean>(`
      (() => {
        const button = [...document.querySelectorAll('.nav-button')]
          .find((item) => item.textContent.includes(${JSON.stringify(text)}));
        if (!button) return false;
        button.click();
        return true;
      })()
    `);

  console.log('1. 首页：标题 + 通知输入模块');
  const title = await cdp.evaluate<string>(`document.querySelector('.app__title')?.textContent ?? ''`);
  check('页面标题正确', title === '信息整合台', `实际 "${title}"`);
  // 首页既可能是空 hash（直接打开根地址），也可能是 #/。
  // 不去把它改写成规范形式：那样会在历史里多插一条，
  // 用户按后退反而像是"没反应"。
  const isHome = () =>
    cdp.evaluate<boolean>(`location.hash === '' || location.hash === '#/'`);
  check('默认停在首页', await isHome(), await cdp.evaluate<string>('location.hash'));
  check('首页有通知输入模块', await cdp.evaluate<boolean>(`Boolean(document.querySelector('#raw-text'))`));
  check(
    '首页不展示卡片列表（要看得点进信息卡页）',
    (await cardCount()) === 0,
    `首页出现了 ${await cardCount()} 张卡`,
  );

  console.log('2. 页头导航：信息卡页 / 设置页 / 点标题回首页');
  check('点了「信息卡」按钮', await clickNav('信息卡'));
  await sleep(600);
  check(
    '切到信息卡页，地址栏同步',
    (await cdp.evaluate<string>('location.hash')) === '#/cards',
    await cdp.evaluate<string>('location.hash'),
  );

  const before = await cardCount();
  const beforeIds = await cardIds();
  // 一张卡都没有也能跑：脚本只动自己新建的那张，绝不碰已有数据
  console.log(`     信息卡页当前渲染 ${before} 张卡${before === 0 ? '（空库）' : ''}`);

  check('点了「设置」按钮', await clickNav('设置'));
  await sleep(600);
  const settingsState = await cdp.evaluate<string>(`
    (() => {
      const hash = location.hash;
      const api = [...document.querySelectorAll('.settings-section__title')]
        .map((item) => item.textContent);
      const planned = document.querySelectorAll('[data-testid="planned-badge"]').length;
      const hasKeyInput = Boolean(document.querySelector('#api-key-input'));
      return JSON.stringify({ hash, api, planned, hasKeyInput });
    })()
  `);
  const settings = JSON.parse(settingsState) as {
    hash: string;
    api: string[];
    planned: number;
    hasKeyInput: boolean;
  };
  check('切到设置页，地址栏同步', settings.hash === '#/settings', settings.hash);
  check('API 调用已经放进设置页', settings.hasKeyInput && settings.api.includes('API 调用'), settingsState);
  check('预留了「外观风格」与「开机自启」', settings.planned === 2, `占位分组 ${settings.planned} 个`);
  check(
    '占位项明确标注了还没实现',
    await cdp.evaluate<boolean>(
      `document.body.textContent.includes('待实现') && document.body.textContent.includes('没做的原因')`,
    ),
  );

  check('点标题回首页', await cdp.evaluate<boolean>(`
    (() => {
      const button = document.querySelector('.app__title-button');
      if (!button) return false;
      button.click();
      return true;
    })()
  `));
  await sleep(600);
  check('回到首页', await isHome(), await cdp.evaluate<string>('location.hash'));

  console.log('3. 在首页提交一条通知');
  const submitted = await cdp.evaluate<string>(`
    (async () => {
      const textarea = document.querySelector('#raw-text');
      if (!textarea) return '首页找不到输入框';
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '【界面验证】请于3月8日24:00前提交报名表，逾期不再受理。');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      document.querySelector('.button--primary').click();
      // 首页看不到卡片列表，所以这里等的是"已生成"那行提示
      const ok = await window.__waitFor(() => document.querySelector('.home__result'));
      if (!ok) {
        const alert = document.querySelector('[role="alert"]');
        return 'failed: ' + (alert ? alert.textContent : '没有出现生成结果提示');
      }
      return document.querySelector('.home__result').textContent;
    })()
  `);
  check('提交后首页给出「已生成」反馈', submitted.startsWith('已生成信息卡'), submitted);

  console.log('4. 从反馈进信息卡页，确认新卡片在列表里');
  check('点了「去信息卡页查看」', await cdp.evaluate<boolean>(`
    (() => {
      const button = [...document.querySelectorAll('.home__result button')]
        .find((item) => item.textContent.trim() === '去信息卡页查看');
      if (!button) return false;
      button.click();
      return true;
    })()
  `));
  await sleep(800);
  check(
    '进到信息卡页',
    (await cdp.evaluate<string>('location.hash')) === '#/cards',
    await cdp.evaluate<string>('location.hash'),
  );

  const afterSubmit = await cardCount();
  check('卡片数 +1', afterSubmit === before + 1, `${before} -> ${afterSubmit}`);
  console.log(`     现在渲染 ${afterSubmit} 张卡`);

  // 列表是按事件时间排的，新卡片不一定在第一张，
  // 所以先算出它的 id，后面所有操作都按 id 定位，绝不靠"第几张"。
  const knownIds: string[] = beforeIds;
  const newId = (await cardIds()).find((id) => !knownIds.includes(id)) ?? null;
  check('能定位到刚生成的卡片', typeof newId === 'string' && newId.length > 0, `实际 ${String(newId)}`);

  const selector = `[data-card-id="${newId}"]`;

  console.log('5. 点击新卡片上的「置顶」按钮');
  const pinResult = await cdp.evaluate<string>(`
    (async () => {
      const card = document.querySelector(${JSON.stringify(selector)});
      if (!card) return 'card-not-found';
      const button = [...card.querySelectorAll('button')].find((item) => item.textContent.trim() === '置顶');
      if (!button) return 'pin-button-not-found';
      button.click();
      const ok = await window.__waitFor(() => {
        const first = document.querySelector('[data-testid="info-card"]');
        if (!first || first.dataset.cardId !== ${JSON.stringify(newId)}) return false;
        return Boolean(first.querySelector('[data-testid="pinned-badge"]'));
      });
      return ok ? 'ok' : '卡片没有移到最前或没有置顶标记';
    })()
  `);
  check('置顶后卡片排到列表最前并显示已置顶', pinResult === 'ok', pinResult);

  const serverCards = await fetch(`${appUrl}/api/cards`)
    .then((response) => response.json() as Promise<{ cards: Array<{ id: string; pinned: boolean }> }>)
    .catch(() => null);
  check(
    '置顶状态真的写进了服务端（不是只改了界面）',
    serverCards?.cards.find((card) => card.id === newId)?.pinned === true,
    JSON.stringify(serverCards?.cards.find((card) => card.id === newId)),
  );

  console.log('6. 再点一次「取消置顶」');
  const unpinResult = await cdp.evaluate<string>(`
    (async () => {
      const card = document.querySelector(${JSON.stringify(selector)});
      if (!card) return 'card-not-found';
      const button = [...card.querySelectorAll('button')].find((item) => item.textContent.trim() === '取消置顶');
      if (!button) return 'unpin-button-not-found';
      button.click();
      const ok = await window.__waitFor(() => {
        const current = document.querySelector(${JSON.stringify(selector)});
        return current && !current.querySelector('[data-testid="pinned-badge"]');
      });
      return ok ? 'ok' : '置顶标记没有消失';
    })()
  `);
  check('取消置顶后标记消失', unpinResult === 'ok', unpinResult);

  console.log('7. 切换排序方式');
  const sortResult = await cdp.evaluate<string>(`
    (async () => {
      const tab = [...document.querySelectorAll('.sort-tab')]
        .find((item) => item.textContent.trim() === '按录入时间');
      if (!tab) return 'sort-tab-not-found';
      tab.click();
      const ok = await window.__waitFor(() =>
        tab.getAttribute('aria-pressed') === 'true'
        && (document.querySelector('[data-testid="sort-hint"]')?.textContent ?? '').includes('最新生成'));
      if (ok) {
        const back = [...document.querySelectorAll('.sort-tab')]
          .find((item) => item.textContent.trim() === '按事件时间');
        back.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return ok ? 'ok' : '切换后按钮状态或规则说明没更新';
    })()
  `);
  check('可以切到「按录入时间」并回到「按事件时间」', sortResult === 'ok', sortResult);

  console.log('8. 点击新卡片的「删除」按钮');
  const deleteResult = await cdp.evaluate<string>(`
    (async () => {
      const card = document.querySelector(${JSON.stringify(selector)});
      if (!card) return 'card-not-found';
      const button = [...card.querySelectorAll('button')].find((item) => item.textContent.trim() === '删除');
      if (!button) return 'not-found';
      button.click();
      const ok = await window.__waitFor(() =>
        document.querySelectorAll('[data-testid="info-card"]').length === ${before});
      if (!ok) {
        const alert = document.querySelector('[role="alert"]');
        return 'failed: ' + (alert ? alert.textContent : '卡片数量未恢复');
      }
      return 'ok';
    })()
  `);
  check('删除后卡片从界面消失', deleteResult === 'ok', deleteResult);
  check('删除过程没有报错提示', !deleteResult.startsWith('failed'));

  const finalCount = await cardCount();
  check('卡片数回到提交前', finalCount === before, `期望 ${before}，实际 ${finalCount}`);
  const finalIds = await cardIds();
  check(
    '其他卡片一张都没被误删',
    beforeIds.every((id) => finalIds.includes(id)),
    `期望保留 ${beforeIds.join(', ')}，实际 ${finalIds.join(', ')}`,
  );

  console.log('9. 核对服务端数据已同步删除');
  const serverTotal = await fetch(`${appUrl}/api/cards`)
    .then((response) => response.json() as Promise<{ total: number }>)
    .then((body) => body.total)
    .catch(() => -1);
  check('服务端条数与界面一致', serverTotal === finalCount, `服务端 ${serverTotal}，界面 ${finalCount}`);

  // 放在最后：这几条只读静态资源与浏览器状态，不碰卡片数据
  console.log('10. PWA：manifest、service worker 与缓存边界');
  const manifestResult = await cdp.evaluate<string>(`
    (async () => {
      const link = document.querySelector('link[rel="manifest"]');
      if (!link) return '页面没有挂 manifest';
      const response = await fetch(link.getAttribute('href'));
      if (!response.ok) return 'manifest HTTP ' + response.status;
      const manifest = await response.json();
      if (!manifest.name || !manifest.start_url || manifest.display !== 'standalone') {
        return 'manifest 缺字段：' + JSON.stringify({ name: manifest.name, start_url: manifest.start_url, display: manifest.display });
      }
      const sizes = (manifest.icons || []).map((icon) => icon.sizes);
      if (!sizes.includes('192x192') || !sizes.includes('512x512')) return '图标尺寸不全：' + sizes.join(',');
      return 'ok';
    })()
  `);
  check('页面取到的 manifest 满足 Chromium 的安装条件', manifestResult === 'ok', manifestResult);

  // 再问浏览器一遍：它自己解析出来的 manifest 有没有报错。
  // 这条比人工核对字段更接近真相——解析规则、图标尺寸、字段合法性都由它判定。
  //
  // 这里本来想验 beforeinstallprompt（浏览器认定可安装时才发），实测无头模式
  // 下它不触发：安装引导是纯 UI 功能，无头浏览器不跑它。留一条永远为假的断言
  // 比不写还糟，所以改用 getAppManifest。
  const appManifest = await cdp.send<{ errors?: unknown[]; data?: string }>('Page.getAppManifest');
  const manifestErrors = appManifest.errors ?? [];
  check(
    '浏览器解析 manifest 没有报错',
    manifestErrors.length === 0,
    JSON.stringify(manifestErrors),
  );
  check('浏览器确实拿到了 manifest 内容', (appManifest.data ?? '').includes('信息整合台'));

  const workerResult = await cdp.evaluate<string>(`
    (async () => {
      if (!('serviceWorker' in navigator)) return '浏览器不支持 service worker';
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (!registration) return 'service worker 8 秒内没有就绪';
      if (!registration.active) return '注册了但没有 active worker';
      const expected = new URL('/sw.js', location.origin).href;
      if (registration.active.scriptURL !== expected) return '脚本地址不对：' + registration.active.scriptURL;
      if (!navigator.serviceWorker.controller) return '已安装但当前页面没有被它接管';
      return 'ok';
    })()
  `);
  check('service worker 已注册、已激活并接管当前页面', workerResult === 'ok', workerResult);

  const cacheResult = await cdp.evaluate<string>(`
    (async () => {
      const names = await caches.keys();
      if (names.length !== 1) return '缓存桶数量不对：' + JSON.stringify(names);
      const cache = await caches.open(names[0]);
      const requests = await cache.keys();
      return JSON.stringify(requests.map((request) => new URL(request.url).pathname).sort());
    })()
  `);
  // 这条是这次改动最要紧的约束：一个字节的应用代码都不许进缓存，
  // 否则重新构建之后打开的还是旧界面，而且旧到让人以为改动没生效
  check(
    '缓存里只有那张离线说明页，没有任何应用代码',
    cacheResult === JSON.stringify(['/offline.html']),
    cacheResult,
  );

  // 这里**故意不**验证"服务停了之后 service worker 交出说明页"那一条，两个原因：
  //
  //   1. 那条路径要求真的把服务停掉再拉起来。让这个脚本去管服务生命周期，
  //      既会动用户正在跑的服务，又让验证本身变得不稳（实测出现过卡住不返回）。
  //      启停是 verify-launcher 的职责，两边都碰就会分叉——项目里已经有过教训。
  //   2. CDP 的 Network.emulateNetworkConditions({offline:true}) 试过了，不能用：
  //      它在请求到达 service worker 之前就把导航掐掉，页面变成浏览器错误页，
  //      看上去"验过了一条类似的检查"，其实根本没走到要验的那段代码。
  //
  // 所以那条留在人工核对里（README「验证」一节写了步骤），
  // 离线回落的**逻辑**由 test/service-worker.test.ts 真跑 sw.js 源码覆盖，
  // 缓存的**边界**由上面这条断言在真实浏览器里覆盖。

  console.log(process.exitCode === 1 ? '\n界面验证失败' : '\n界面验证全部通过');
  cdp.close();
}

try {
  await main();
} finally {
  browser.kill();
  await sleep(300);
  fs.rmSync(profileDir, { recursive: true, force: true });
}
