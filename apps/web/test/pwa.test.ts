import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * PWA 安装条件的契约测试。
 *
 * 这些文件是静态的构建产物输入，没有类型系统兜着：漏一个 512 图标、
 * 把 start_url 写成绝对地址、图标路径写错，界面照常工作，
 * 只有"装不上"这一个症状，而且不会报错。所以这里按浏览器真正检查的
 * 那几条逐项断言（见 https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable）。
 */
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(webRoot, 'public');

function readManifest(): Record<string, unknown> {
  const file = path.join(publicDir, 'manifest.webmanifest');
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

interface ManifestIcon {
  src?: unknown;
  sizes?: unknown;
  type?: unknown;
  purpose?: unknown;
}

/** 从 PNG 头里读真实宽高，用来核对 sizes 声明没有撒谎 */
function readPngSize(file: string): { width: number; height: number } {
  const buffer = fs.readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(buffer.subarray(0, 8).equals(signature), `${file} 不是 PNG`).toBe(true);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

describe('manifest.webmanifest', () => {
  it('能被解析成 JSON 对象', () => {
    expect(typeof readManifest()).toBe('object');
  });

  it('包含 Chromium 要求的字段', () => {
    const manifest = readManifest();
    expect(typeof manifest.name).toBe('string');
    expect((manifest.name as string).length).toBeGreaterThan(0);
    expect(manifest.short_name).toBe('信息整合台');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
    // 这一项为 true 时浏览器不会提示安装
    expect(manifest.prefer_related_applications).not.toBe(true);
  });

  it('start_url 与 scope 是站内相对路径，换端口/换机器都还能装', () => {
    const manifest = readManifest();
    // 写成 http://127.0.0.1:5178/ 就会把端口写死，改端口后装上的是另一个应用
    for (const field of ['start_url', 'scope', 'id'] as const) {
      expect(String(manifest[field])).toMatch(/^\//);
    }
  });

  it('同时提供 192 与 512 的图标，且 purpose 里有 any 和 maskable', () => {
    const icons = (readManifest().icons ?? []) as ManifestIcon[];
    const sizes = icons.map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');

    const purposes = icons.map((icon) => icon.purpose);
    expect(purposes).toContain('any');
    expect(purposes).toContain('maskable');
  });

  it('每个图标文件都存在，且真实尺寸与 sizes 声明一致', () => {
    const icons = (readManifest().icons ?? []) as ManifestIcon[];
    expect(icons.length).toBeGreaterThan(0);

    for (const icon of icons) {
      const src = String(icon.src);
      // 相对路径才能跟着同一个来源走；绝对 URL 会指向另一个域
      expect(src.startsWith('/'), `${src} 应为站内绝对路径`).toBe(true);
      expect(icon.type).toBe('image/png');

      const file = path.join(publicDir, src.replace(/^\//, ''));
      expect(fs.existsSync(file), `缺少图标文件 ${src}`).toBe(true);

      const declared = String(icon.sizes);
      const match = /^(\d+)x(\d+)$/.exec(declared);
      expect(match, `sizes 格式不对：${declared}`).not.toBeNull();

      const measured = readPngSize(file);
      // 声明 512 而文件其实是别的尺寸，会让浏览器判定为"没有合格图标"
      expect(`${measured.width}x${measured.height}`).toBe(declared);
    }
  });

  it('theme_color 与界面底色一致，独立窗口的标题栏不会突兀', () => {
    expect(readManifest().theme_color).toBe('#faf8f3');
  });
});

describe('index.html 与静态资源', () => {
  const indexHtml = fs.readFileSync(path.join(webRoot, 'index.html'), 'utf8');

  it('挂上了 manifest、favicon 与 theme-color', () => {
    expect(indexHtml).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(indexHtml).toContain('rel="icon"');
    expect(indexHtml).toContain('name="theme-color"');
  });

  it('favicon 指向的矢量文件真实存在（PNG 与 SVG 同源，避免各画一份）', () => {
    expect(fs.existsSync(path.join(publicDir, 'icon.svg'))).toBe(true);
  });

  it('离线说明页完全自包含：不引用任何打包产物', () => {
    const offline = fs.readFileSync(path.join(publicDir, 'offline.html'), 'utf8');
    // 服务没跑时任何外部资源都取不到，引用 /assets/ 会让说明页自己也白屏
    expect(offline).not.toMatch(/\/assets\//);
    expect(offline).not.toMatch(/<script[^>]+src=/);
    expect(offline).not.toMatch(/<link[^>]+stylesheet/);
    expect(offline).toContain('启动信息整合台.bat');
  });
});
