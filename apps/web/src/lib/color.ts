/**
 * 颜色的 RGB 表示与十六进制互转。
 *
 * 存储层（settings.json）用的是 `#rrggbb` 十六进制字符串，
 * 而滑块与色盘要按 R/G/B 三个通道操作，所以需要一层可靠的互转。
 * 这里的函数都是纯函数，越界值会被钳制而不是抛错——
 * 滑块、手输、色盘三处输入都可能给出 0-255 之外的值。
 */

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** 把一个数值钳到 0-255 的整数；NaN 归 0，无穷收敛到对应边界 */
export function clampChannel(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value === Number.POSITIVE_INFINITY) return 255;
  if (value === Number.NEGATIVE_INFINITY) return 0;
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** `#rrggbb` → RGB；非法输入返回 null（调用方据此决定回退策略） */
export function hexToRgb(hex: string): RgbColor | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match?.[1]) return null;
  const value = match[1];
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

/** RGB → `#rrggbb`（小写）；通道越界会被钳制 */
export function rgbToHex(rgb: RgbColor): string {
  const toHex = (value: number) => clampChannel(value).toString(16).padStart(2, '0');
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

/**
 * 尽量把任意输入当成颜色解析。
 * 支持 `#rrggbb`、`rrggbb`，以及手输时常见的 `#rgb` 简写；解析不了返回 null。
 */
export function parseColorInput(input: string): RgbColor | null {
  const trimmed = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
    return hexToRgb(trimmed);
  }
  // #abc → #aabbcc
  if (/^[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [a, b, c] = trimmed.split('');
    if (a && b && c) return hexToRgb(`${a}${a}${b}${b}${c}${c}`);
  }
  return null;
}

/** 十六进制输入是否合法（用于表单校验） */
export function isValidHex(input: string): boolean {
  return parseColorInput(input) !== null;
}

/** 感知亮度（0-255）；用来决定叠在上面的文字用深色还是浅色 */
export function perceivedBrightness(rgb: RgbColor): number {
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
}

/**
 * 给某个背景色挑一个能看清的前景色。
 * 浅色底用深字、深色底用白字——否则用户把荧光笔调成浅黄时，
 * 条上的白色标题会糊成一片。
 */
export function readableTextColor(hex: string, dark = '#3a352c', light = '#fffdf9'): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return light;
  return perceivedBrightness(rgb) > 165 ? dark : light;
}

/** 生成某个通道的滑条背景渐变，让滑块本身有颜色提示 */
export function channelGradient(rgb: RgbColor, channel: keyof RgbColor): string {
  const from = rgbToHex({ ...rgb, [channel]: 0 });
  const to = rgbToHex({ ...rgb, [channel]: 255 });
  return `linear-gradient(to right, ${from}, ${to})`;
}
