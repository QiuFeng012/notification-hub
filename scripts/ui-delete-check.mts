/**
 * 界面真实交互验证：用 Chrome DevTools Protocol 驱动无头浏览器，
 * 真实点击「删除」按钮，确认卡片从界面和数据库中一并消失。
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

  console.log('1. 页面加载');
  const title = await cdp.evaluate<string>(`document.querySelector('.app__title')?.textContent ?? ''`);
  check('页面标题正确', title === '信息整合台', `实际 "${title}"`);

  const before = await cardCount();
  check('至少渲染出一张信息卡', before > 0, `实际 ${before} 张`);
  console.log(`     当前渲染 ${before} 张卡`);

  console.log('2. 通过界面提交一条通知');
  const submitted = await cdp.evaluate<boolean>(`
    (async () => {
      const textarea = document.querySelector('#raw-text');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '【界面验证】请于3月8日24:00前提交报名表，逾期不再受理。');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      document.querySelector('.button--primary').click();
      const ok = await window.__waitFor(() =>
        document.querySelectorAll('[data-testid="info-card"]').length === ${before} + 1);
      return Boolean(ok);
    })()
  `);
  check('提交后卡片数 +1', submitted);

  const afterSubmit = await cardCount();
  console.log(`     现在渲染 ${afterSubmit} 张卡`);

  console.log('3. 点击第一张卡的「删除」按钮');
  const deleteResult = await cdp.evaluate<string>(`
    (async () => {
      const firstCard = document.querySelector('[data-testid="info-card"]');
      const button = [...firstCard.querySelectorAll('button')]
        .find((item) => item.textContent.trim() === '删除');
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

  console.log('4. 核对服务端数据已同步删除');
  const serverTotal = await fetch(`${appUrl}/api/cards`)
    .then((response) => response.json() as Promise<{ total: number }>)
    .then((body) => body.total)
    .catch(() => -1);
  check('服务端条数与界面一致', serverTotal === finalCount, `服务端 ${serverTotal}，界面 ${finalCount}`);

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
