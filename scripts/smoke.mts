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

  console.log('3. 删除信息卡（本次修复的目标路径）');
  await api.deleteCard(created.id);

  const afterDelete = await api.listCards();
  check('列表条数恢复', afterDelete.length === before.length, `${afterCreate.length} -> ${afterDelete.length}`);
  check('被删的卡不在列表里', !afterDelete.some((card) => card.id === created.id));

  console.log('4. 删除不存在的卡片应报错');
  let errored = false;
  try {
    await api.deleteCard(created.id);
  } catch {
    errored = true;
  }
  check('重复删除会抛错', errored);

  console.log(process.exitCode === 1 ? '\n冒烟测试失败' : '\n冒烟测试全部通过');
}

await main();
