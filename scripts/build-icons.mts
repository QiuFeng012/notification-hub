/**
 * 生成 PWA 图标（PNG）。
 *
 * 为什么让浏览器来栅格化：manifest 要求 192 和 512 的位图图标，而位图必须
 * 有真正的抗锯齿。装 sharp / node-canvas 这类图像库会引入原生依赖，和这个项目
 * 「服务端零原生依赖」的取向冲突；而浏览器本来就在（screenshot.mts、
 * verify:ui 都要用），让它把一份 SVG 渲染成 PNG 是成本最低的一条路。
 *
 * SVG 是这个脚本里的字符串，也就是图标的唯一来源：跟着一起产出 icon.svg
 * 给浏览器标签页当 favicon，避免"PNG 和 SVG 各画一份、改了一个忘了另一个"。
 *
 * 用法：npx tsx scripts/build-icons.mts
 * 产物直接提交进仓库（apps/web/public/）；只有改图标时才需要重跑。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'apps', 'web', 'public');

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const browserPath = BROWSERS.find((candidate) => fs.existsSync(candidate));
if (!browserPath) {
  console.error('找不到可用的 Chromium 内核浏览器，无法生成图标');
  process.exit(2);
}

const CDP_PORT = 9444;

// 配色取自 styles.css 的 :root，图标和界面必须是同一套颜色。
// 底色用比页面米白（#faf8f3）更深的暖沙色：图标经常贴在纯白背景上
// （浏览器标签页、开始菜单、白色任务栏），沿用页面底色会糊成一片没有边界。
const TILE = '#efe9dc';
const CARD = '#fffefb';
const BORDER = '#ded6c4';
const ACCENT = '#b4643f';
const LINE = '#c9c1b0';

/**
 * 图标本体：一张信息卡。
 *
 * 画的是界面里真实存在的东西——一张白卡，左边一条强调色，右边几行要点。
 * 小尺寸下必须一眼能认出来，所以刻意只保留这三个元素。
 *
 * @param opts.inset 内容缩放比例。maskable 图标会被系统裁成圆形，
 *   安全区只有中间 80%，内容必须缩小并居中。
 */
function buildSvg(opts: { inset: number; fullBleed: boolean; size: number }): string {
  const { inset, fullBleed, size } = opts;
  const radius = fullBleed ? 0 : 112;
  // 内容按 inset 围绕中心缩放
  const scale = inset;
  const translate = (512 * (1 - scale)) / 2;

  const cardX = 104;
  const cardY = 124;
  const cardW = 304;
  const cardH = 264;

  const barX = 140;
  const barY = 168;
  const barW = 20;
  const barH = 176;

  const lineX = 190;
  const lineW = 178;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512" role="img" aria-label="信息整合台">
  <rect x="0" y="0" width="512" height="512" rx="${radius}" fill="${TILE}"/>
  <g transform="translate(${translate} ${translate}) scale(${scale})">
    <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="30" fill="${CARD}" stroke="${BORDER}" stroke-width="9"/>
    <rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="${barW / 2}" fill="${ACCENT}"/>
    <rect x="${lineX}" y="${barY + 6}" width="${lineW}" height="22" rx="11" fill="${LINE}"/>
    <rect x="${lineX}" y="${barY + 62}" width="${lineW - 52}" height="22" rx="11" fill="${LINE}"/>
    <rect x="${lineX}" y="${barY + 118}" width="${lineW - 26}" height="22" rx="11" fill="${LINE}"/>
  </g>
</svg>
`;
}

/**
 * 把 SVG 内联进一个铺满视口、背景透明的页面。
 * 内联而不是 `<img src>`：内联时 SVG 的尺寸完全由页面决定，
 * deviceMetrics 给多少就渲染多少，不会受图片固有尺寸影响。
 */
function buildDocument(svg: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
  svg { display: block; width: 100vw; height: 100vh; }
</style></head><body>${svg}</body></html>`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

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
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const id = nextId;
      nextId += 1;
      const promise = new Promise<CdpMessage>((resolve) => pending.set(id, resolve));
      socket.send(JSON.stringify({ id, method, params }));
      const message = await promise;
      if (message.error) throw new Error(`${method}: ${message.error.message}`);
      return message.result as T;
    },
    close() {
      socket.close();
    },
  };
}

async function findPageTarget(): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
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

/** 直接读 PNG 头里的宽高，确认渲染出来的确实是声明尺寸 */
function readPngSize(file: string): { width: number; height: number } | null {
  const buffer = fs.readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-hub-icons-'));
const browser = spawn(
  browserPath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let failed = false;

async function main(): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true });

  const cdp = createCdp(await findPageTarget());
  await cdp.ready;
  await cdp.send('Page.enable');
  // 圆角以外必须透明，否则图标四角会是白的，在任何非白背景上都露馅
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 },
  });

  const jobs = [
    { svg: buildSvg({ inset: 1, fullBleed: false, size: 512 }), size: 192, out: 'icon-192.png' },
    { svg: buildSvg({ inset: 1, fullBleed: false, size: 512 }), size: 512, out: 'icon-512.png' },
    // maskable 会被裁成圆形，所以背景铺满、内容缩到安全区内
    { svg: buildSvg({ inset: 0.78, fullBleed: true, size: 512 }), size: 512, out: 'icon-maskable-512.png' },
  ];

  for (const job of jobs) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: job.size,
      height: job.size,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // 用 data: URL 而不是写临时文件：少一个需要清理的中间产物
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(buildDocument(job.svg))}`;
    await cdp.send('Page.navigate', { url });
    await sleep(400);

    const shot = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' });
    const file = path.join(outDir, job.out);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));

    const measured = readPngSize(file);
    const ok = measured?.width === job.size && measured.height === job.size;
    if (!ok) failed = true;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${job.out}  ${measured?.width}x${measured?.height}  ${fs.statSync(file).size} bytes`,
    );
  }

  // favicon 用同一份矢量图，避免和 PNG 各画一份
  const svgFile = path.join(outDir, 'icon.svg');
  fs.writeFileSync(svgFile, buildSvg({ inset: 1, fullBleed: false, size: 512 }));
  console.log(`  OK    icon.svg  ${fs.statSync(svgFile).size} bytes`);

  cdp.close();
}

try {
  await main();
} catch (error) {
  failed = true;
  console.error(`生成图标失败：${String(error)}`);
} finally {
  browser.kill();
  await sleep(300);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

console.log(failed ? '\n图标生成失败' : '\n图标已生成');
process.exitCode = failed ? 1 : 0;
