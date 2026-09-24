/**
 * 界面截图：用 CDP 打开页面、可选执行一段脚本、再截图。
 *
 * 用途：改动界面后肉眼核对（AGENTS.md 规则 3 要求"实际看一眼渲染结果"）。
 *
 * 用法：
 *   npx tsx scripts/screenshot.mts --out shot.png
 *   npx tsx scripts/screenshot.mts --out shot.png --click "API 设置" --width 1280 --height 900
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function readArg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? String(process.argv[index + 1]) : fallback;
}

const appUrl = readArg('url', 'http://127.0.0.1:5178').replace(/\/+$/, '');
const outPath = path.resolve(readArg('out', 'screenshot.png'));
const clickText = readArg('click', '');
const width = Number(readArg('width', '1280'));
const height = Number(readArg('height', '900'));
const cdpPort = Number(readArg('port', '9333'));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browserPath = BROWSERS.find((candidate) => fs.existsSync(candidate));
if (!browserPath) {
  console.error('找不到可用的 Chromium 内核浏览器');
  process.exit(2);
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-hub-shot-'));
const browser = spawn(
  browserPath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    `--window-size=${width},${height}`,
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
      // 浏览器还没起来
    }
    await sleep(250);
  }
  throw new Error('无法连接到浏览器调试端口');
}

function createCdp(wsUrl: string) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  let nextId = 1;

  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number };
    if (typeof message.id === 'number') {
      pending.get(message.id)?.(message as { result?: unknown });
      pending.delete(message.id);
    }
  });

  return {
    ready,
    send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const id = nextId;
      nextId += 1;
      const promise = new Promise<{ result?: unknown; error?: { message: string } }>((resolve) =>
        pending.set(id, resolve),
      );
      socket.send(JSON.stringify({ id, method, params }));
      return promise.then((message) => {
        if (message.error) throw new Error(message.error.message);
        return message.result as T;
      });
    },
    close() {
      socket.close();
    },
  };
}

async function main(): Promise<void> {
  const cdp = createCdp(await findPageTarget());
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await cdp.send('Page.navigate', { url: appUrl });
  await sleep(1800);

  if (clickText) {
    const clicked = await cdp.send<{ result: { value: boolean } }>('Runtime.evaluate', {
      expression: `
        (() => {
          const target = [...document.querySelectorAll('button, summary, a')]
            .find((el) => el.textContent && el.textContent.includes(${JSON.stringify(clickText)}));
          if (!target) return false;
          target.click();
          return true;
        })()
      `,
      returnByValue: true,
    });
    if (!clicked.result.value) {
      console.error(`没有找到包含「${clickText}」的可点击元素`);
      process.exitCode = 1;
    }
    await sleep(700);
  }

  const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log(`已保存截图：${outPath} (${fs.statSync(outPath).size} bytes)`);
  cdp.close();
}

try {
  await main();
} finally {
  browser.kill();
  await sleep(300);
  fs.rmSync(profileDir, { recursive: true, force: true });
}
