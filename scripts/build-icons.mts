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
import zlib from 'node:zlib';
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

/** PNG 用 zlib 压缩，Node 自带，不需要任何图像库 */
function readChunks(file: string): Array<{ type: string; data: Buffer }> {
  const buffer = fs.readFileSync(file);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const chunks: Array<{ type: string; data: Buffer }> = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = view.getUint32(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  return chunks;
}

/** 读 PNG 的 IHDR：宽、高、位深、颜色类型 */
function readPngHeader(file: string): { width: number; height: number; depth: number; colorType: number } | null {
  const ihdr = readChunks(file).find((chunk) => chunk.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13) return null;
  return {
    width: ihdr.data.readUInt32BE(0),
    height: ihdr.data.readUInt32BE(4),
    depth: ihdr.data[8] ?? 0,
    colorType: ihdr.data[9] ?? 0,
  };
}

/**
 * 生成 Windows 快捷方式用的多尺寸 .ico（16 / 32 / 48 / 256）。
 *
 * 几个刻意的选择：
 *
 * 1. **自己拼容器，不引入图像库。** 这份图标的唯一来源是本文件里的 SVG，
 *    由浏览器栅格化成 PNG——那个能力本来就在（见文件头）。剩下的只是把
 *    已有的 PNG 像素重新打包成 .ico，为此装一个原生图像库说不过去，
 *    而且和这个项目「服务端零原生依赖」的取向冲突。
 *
 * 2. **PNG 解压只做到"够用"。** 浏览器截图必然是 8 位深、无隔行，
 *    颜色类型只有 2（真彩）和 6（真彩加透明）。遇到别的形态就直接报错，
 *    而不是假装它能用——静默产出一个坏图标，比明确失败糟得多。
 *
 * 3. **条目用原生 BMP 而不是内嵌 PNG。** Vista 以上都支持内嵌 PNG，
 *    但 BMP 是每一种 Windows 版本、每一个会读图标的地方都认的形态，
 *    在这里省下的几十 KB 不值得换一次"在某些地方图标是空白"的风险。
 *
 * @param sizes 需要包含的边长；每一项都必须已经有渲染好的 PNG
 * @param sources 边长 → PNG 文件路径
 */
function writeIco(sizes: number[], sources: Map<number, string>, outFile: string): void {
  // 32bpp BGRA 的行，每行按 4 字节对齐（宽度是 4 的倍数时天然对齐）
  function toBgra(file: string, size: number): Buffer {
    const header = readPngHeader(file);
    if (!header) throw new Error(`${file} 不是合法的 PNG`);
    if (header.width !== size || header.height !== size) {
      throw new Error(`${file} 尺寸是 ${header.width}x${header.height}，期望 ${size}x${size}`);
    }
    if (header.depth !== 8 || (header.colorType !== 2 && header.colorType !== 6)) {
      throw new Error(
        `${file} 是位深 ${header.depth} / 颜色类型 ${header.colorType}，只支持 8 位真彩（2 或 6）`,
      );
    }
    const channels = header.colorType === 6 ? 4 : 3;

    const idat = Buffer.concat(
      readChunks(file)
        .filter((chunk) => chunk.type === 'IDAT')
        .map((chunk) => chunk.data),
    );
    const raw = zlib.inflateSync(idat);

    const stride = header.width * channels;
    const pixels = Buffer.alloc(size * size * 4);
    let previous = Buffer.alloc(stride);
    let offset = 0;

    for (let y = 0; y < size; y += 1) {
      const filter = raw[offset] ?? 0;
      offset += 1;
      const line = Buffer.from(raw.subarray(offset, offset + stride));
      offset += stride;

      // 逐行还原 PNG 过滤器（规范里的 5 种）
      for (let x = 0; x < stride; x += 1) {
        const a = x >= channels ? (line[x - channels] ?? 0) : 0;
        const b = previous[x] ?? 0;
        const c = x >= channels ? (previous[x - channels] ?? 0) : 0;
        const value = line[x] ?? 0;
        let restored: number;
        switch (filter) {
          case 0: restored = value; break;
          case 1: restored = value + a; break;
          case 2: restored = value + b; break;
          case 3: restored = value + ((a + b) >> 1); break;
          case 4: {
            // Paeth
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            restored = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
            break;
          }
          default: throw new Error(`${file} 使用了不支持的过滤器类型 ${filter}`);
        }
        line[x] = restored & 0xff;
      }

      for (let x = 0; x < size; x += 1) {
        const from = x * channels;
        const to = (y * size + x) * 4;
        // PNG 是 RGBA，BMP 是 BGRA，红蓝要互换
        pixels[to] = line[from + 2] ?? 0;
        pixels[to + 1] = line[from + 1] ?? 0;
        pixels[to + 2] = line[from] ?? 0;
        pixels[to + 3] = channels === 4 ? (line[from + 3] ?? 0) : 255;
      }

      previous = line;
    }

    const strideBgra = size * 4; // 宽度是 4 的倍数，天然 4 字节对齐
    const xor = Buffer.alloc(strideBgra * size);
    for (let y = 0; y < size; y += 1) {
      // BMP 的行序是自下而上，所以要翻转
      const source = (size - 1 - y) * strideBgra;
      pixels.copy(xor, y * strideBgra, source, source + strideBgra);
    }

    const maskStride = Math.ceil(size / 32) * 4;
    const mask = Buffer.alloc(maskStride * size); // 全 0 = 全部不透明，真正的不透明信息在 alpha 通道

    const headerSize = 40;
    const imageSize = headerSize + xor.length + mask.length;
    const bitmap = Buffer.alloc(imageSize);
    bitmap.writeUInt32LE(headerSize, 0);
    bitmap.writeInt32LE(size, 4);
    bitmap.writeInt32LE(size * 2, 8); // 高度要写两倍：XOR 位图 + AND 掩码
    bitmap.writeUInt16LE(1, 12); // 平面数
    bitmap.writeUInt16LE(32, 14); // 位深
    bitmap.writeUInt32LE(0, 16); // 不压缩
    bitmap.writeUInt32LE(xor.length + mask.length, 20);
    xor.copy(bitmap, headerSize);
    mask.copy(bitmap, headerSize + xor.length);
    return bitmap;
  }

  const images = sizes.map((size) => {
    const file = sources.get(size);
    if (!file) throw new Error(`缺少 ${size}x${size} 的图标来源`);
    return { size, data: toBgra(file, size) };
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // 保留位
  header.writeUInt16LE(1, 2); // 类型：1 = 图标
  header.writeUInt16LE(images.length, 4); // 条目数

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const at = index * 16;
    // 256 在这个字段里写作 0，这是 ICO 格式的历史约定
    directory[at] = image.size >= 256 ? 0 : image.size;
    directory[at + 1] = image.size >= 256 ? 0 : image.size;
    directory[at + 2] = 0; // 调色板颜色数：真彩没有调色板
    directory[at + 3] = 0; // 保留位
    directory.writeUInt16LE(1, at + 4); // 平面数
    directory.writeUInt16LE(32, at + 6); // 位深
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });

  fs.writeFileSync(outFile, Buffer.concat([header, directory, ...images.map((image) => image.data)]));
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
    // 桌面快捷方式的图标要有 16/32/48/256 这几个尺寸：Windows 在不同位置
    // （桌面、任务栏、Alt+Tab）取不同尺寸，只有 256 会导致缩略时糊成一团
    { svg: buildSvg({ inset: 1, fullBleed: false, size: 512 }), size: 16, out: 'icon-16.png' },
    { svg: buildSvg({ inset: 1, fullBleed: false, size: 512 }), size: 32, out: 'icon-32.png' },
    { svg: buildSvg({ inset: 1, fullBleed: false, size: 512 }), size: 48, out: 'icon-48.png' },
    { svg: buildSvg({ inset: 1, fullBleed: false, size: 512 }), size: 256, out: 'icon-256.png' },
  ];

  const rendered = new Map<number, string>();

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
    else rendered.set(job.size, file);
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${job.out}  ${measured?.width}x${measured?.height}  ${fs.statSync(file).size} bytes`,
    );
  }

  // favicon 用同一份矢量图，避免和 PNG 各画一份
  const svgFile = path.join(outDir, 'icon.svg');
  fs.writeFileSync(svgFile, buildSvg({ inset: 1, fullBleed: false, size: 512 }));
  console.log(`  OK    icon.svg  ${fs.statSync(svgFile).size} bytes`);

  // 桌面快捷方式要的是 .ico。它和 PNG 出自同一次渲染，
  // 所以不存在"快捷方式和 PWA 图标长得不一样"。
  if (!failed) {
    try {
      const icoFile = path.join(outDir, 'icon.ico');
      writeIco([16, 32, 48, 256], rendered, icoFile);
      console.log(`  OK    icon.ico  ${fs.statSync(icoFile).size} bytes（16/32/48/256）`);
    } catch (error) {
      failed = true;
      console.error(`  FAIL  生成 icon.ico 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 单个尺寸的 PNG 只是为了拼 .ico，浏览器读的是 192 / 512 / maskable。
  // 留在 public/ 里会同时进 dist，白占体积也让人以为它们有用。
  for (const size of [16, 32, 48, 256]) {
    fs.rmSync(path.join(outDir, `icon-${size}.png`), { force: true });
  }

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
