/**
 * 真实链路冒烟测试：用前端实际使用的 API 客户端，打真实运行中的服务端。
 *
 * 存在的意义：单元测试里 fetch 是 mock，不校验请求头与协议细节，
 * 曾因此漏掉"DELETE 带 Content-Type 导致 400"的缺陷。
 * 这里跑的是真客户端 + 真服务端，能拦住那一类问题。
 *
 * 用法：先启动服务端，再执行
 *   npx tsx scripts/smoke.mts [baseUrl]
 */
import { createCardApi } from '../apps/web/src/lib/api';

const baseUrl = (process.argv[2] ?? 'http://127.0.0.1:5178').replace(/\/+$/, '');
const api = createCardApi();
const realFetch = globalThis.fetch;

// 把相对路径请求接到真实的本地服务端上
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' && input.startsWith('/') ? `${baseUrl}${input}` : input;
  return realFetch(url as RequestInfo, init);
}) as typeof fetch;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  console.log(`冒烟测试目标：${baseUrl}\n`);

  console.log('1. 列表接口');
  const before = await api.listCards();
  check('能读到信息卡列表', Array.isArray(before), `实际类型 ${typeof before}`);
  console.log(`     当前共有 ${before.length} 张卡`);

  console.log('2. 生成信息卡');
  const created = await api.createCard('【冒烟测试】请于3月8日24:00前提交报名表，联系人张老师。');
  check('返回了卡片 id', typeof created.id === 'string' && created.id.length > 0);
  check('标题非空', created.title.length > 0, `标题为 "${created.title}"`);
  check('要点非空', created.keyPoints.length > 0);
  console.log(`     标题：${created.title}`);
  console.log(`     要点：${created.keyPoints.length} 条`);

  const afterCreate = await api.listCards();
  check('列表条数 +1', afterCreate.length === before.length + 1, `${before.length} -> ${afterCreate.length}`);
  check('新卡排在首位', afterCreate[0]?.id === created.id);

  console.log('3. 置顶 / 取消置顶（真实协议：PUT + JSON body 的独立接口）');
  const pinned = await api.setPinned(created.id, true);
  check('置顶后返回 pinned=true', pinned.pinned === true);
  check(
    '置顶不算内容改动：不改标题、不计入改动次数',
    pinned.title === created.title && pinned.revisionCount === created.revisionCount,
    `revisionCount ${created.revisionCount} -> ${pinned.revisionCount}`,
  );

  const listedAfterPin = (await (await fetch(`${baseUrl}/api/cards`)).json()) as {
    cards: Array<{ id: string; pinned: boolean }>;
  };
  check(
    '列表接口能读回置顶状态（说明真写进了库）',
    listedAfterPin.cards.find((card) => card.id === created.id)?.pinned === true,
  );

  const unpinned = await api.setPinned(created.id, false);
  check('取消置顶后返回 pinned=false', unpinned.pinned === false);

  console.log('4. 删除信息卡（曾经出过协议问题的路径）');
  await api.deleteCard(created.id);

  const afterDelete = await api.listCards();
  check('列表条数恢复', afterDelete.length === before.length, `${afterCreate.length} -> ${afterDelete.length}`);
  check('被删的卡不在列表里', !afterDelete.some((card) => card.id === created.id));

  console.log('5. 删除不存在的卡片应报错');
  let errored = false;
  try {
    await api.deleteCard(created.id);
  } catch {
    errored = true;
  }
  check('重复删除会抛错', errored);

  console.log('6. API 设置接口（只读检查，不改动你的配置）');
  const settingsResponse = await fetch(`${baseUrl}/api/settings`);
  check('GET /api/settings 返回 200', settingsResponse.ok, `HTTP ${settingsResponse.status}`);
  const settingsText = await settingsResponse.text();
  const settings = JSON.parse(settingsText) as Record<string, unknown>;

  check('返回 configured 字段', typeof settings.configured === 'boolean');
  check(
    'source 取值合法',
    settings.source === 'user' || settings.source === 'env' || settings.source === 'mock',
    `实际 ${String(settings.source)}`,
  );
  check('未配置时掩码为 null', settings.configured === true || settings.apiKeyMask === null);
  console.log(`     当前来源：${String(settings.source)}，模型：${String(settings.model)}`);

  // 安全断言：接口响应里不该出现任何形似完整密钥的长串
  const looksLikeFullKey = /sk-[A-Za-z0-9_-]{20,}/.test(settingsText);
  check('响应里不含完整密钥', !looksLikeFullKey);
  if (settings.configured === true) {
    console.log(`     Key 掩码：${String(settings.apiKeyMask)}`);
  }

  console.log('7. 非法设置应被拒绝而不是 500');
  const tooLong = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 'x'.repeat(201) }),
  });
  check('超长 Key 返回 400', tooLong.status === 400, `HTTP ${tooLong.status}`);
  const wrongType = await fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: 123 }),
  });
  check('字段类型不对返回 400', wrongType.status === 400, `HTTP ${wrongType.status}`);

  console.log('8. PWA 静态资源（可安装性全押在这些响应上）');
  // 这些文件由 @fastify/static 按扩展名猜 MIME。猜错不会报错，只会"装不上"，
  // 而且单元测试碰不到——所以必须打真实服务端。
  const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
  check('GET /manifest.webmanifest 返回 200', manifestResponse.ok, `HTTP ${manifestResponse.status}`);
  const manifestType = manifestResponse.headers.get('content-type') ?? '';
  check(
    'Content-Type 是 application/manifest+json',
    manifestType.includes('application/manifest+json'),
    manifestType,
  );

  const manifestText = await manifestResponse.text();
  let manifest: { name?: unknown; start_url?: unknown; icons?: Array<{ src?: string; sizes?: string }> } = {};
  try {
    manifest = JSON.parse(manifestText) as typeof manifest;
  } catch {
    check('manifest 是合法 JSON', false, manifestText.slice(0, 80));
  }
  check('manifest 有 name', typeof manifest.name === 'string' && manifest.name.length > 0);
  check('start_url 是站内路径', String(manifest.start_url ?? '').startsWith('/'));

  const iconSizes = (manifest.icons ?? []).map((icon) => String(icon.sizes));
  check(
    '图标同时覆盖 192 与 512',
    iconSizes.includes('192x192') && iconSizes.includes('512x512'),
    iconSizes.join(' / '),
  );

  for (const icon of manifest.icons ?? []) {
    const response = await fetch(`${baseUrl}${String(icon.src)}`);
    const type = response.headers.get('content-type') ?? '';
    check(
      `${String(icon.src)} 可访问且是 PNG`,
      response.ok && type.includes('image/png'),
      `HTTP ${response.status} ${type}`,
    );
  }

  const swResponse = await fetch(`${baseUrl}/sw.js`);
  const swType = swResponse.headers.get('content-type') ?? '';
  check('GET /sw.js 返回 200', swResponse.ok, `HTTP ${swResponse.status}`);
  // 浏览器拒绝用非 JavaScript MIME 注册 service worker
  check('sw.js 的 MIME 是 JavaScript', /javascript/.test(swType), swType);

  const offlineResponse = await fetch(`${baseUrl}/offline.html`);
  const offlineBody = await offlineResponse.text();
  check('GET /offline.html 返回 200', offlineResponse.ok, `HTTP ${offlineResponse.status}`);
  check(
    'offline.html 没有被 SPA 回退成 index.html',
    offlineBody.includes('服务没有在运行') && !offlineBody.includes('/src/main.tsx'),
    offlineBody.slice(0, 60),
  );

  const shell = await (await fetch(`${baseUrl}/`)).text();
  check('首页挂上了 manifest', shell.includes('/manifest.webmanifest'));

  console.log(process.exitCode === 1 ? '\n冒烟测试失败' : '\n冒烟测试全部通过');
}

await main();
