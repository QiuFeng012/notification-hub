import { describe, expect, it } from 'vitest';
import {
  channelGradient,
  clampChannel,
  hexToRgb,
  isValidHex,
  parseColorInput,
  perceivedBrightness,
  readableTextColor,
  rgbToHex,
} from '../src/lib/color';

describe('clampChannel', () => {
  it('钳制到 0-255 并取整', () => {
    expect(clampChannel(-20)).toBe(0);
    expect(clampChannel(0)).toBe(0);
    expect(clampChannel(128.6)).toBe(129);
    expect(clampChannel(255)).toBe(255);
    expect(clampChannel(999)).toBe(255);
  });

  it('NaN / Infinity 归 0 或边界，不抛错', () => {
    expect(clampChannel(Number.NaN)).toBe(0);
    expect(clampChannel(Number.POSITIVE_INFINITY)).toBe(255);
    // Math.round(Infinity) 仍是 Infinity，靠 Math.min 收敛到上界
    expect(clampChannel(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('hexToRgb 与 rgbToHex', () => {
  it('互转正确', () => {
    expect(hexToRgb('#b4643f')).toEqual({ r: 0xb4, g: 0x64, b: 0x3f });
    expect(rgbToHex({ r: 0xb4, g: 0x64, b: 0x3f })).toBe('#b4643f');
  });

  it('接受不带 # 的写法与大小写', () => {
    expect(hexToRgb('B4643F')).toEqual({ r: 180, g: 100, b: 63 });
    expect(hexToRgb('  #b4643f  ')).toEqual({ r: 180, g: 100, b: 63 });
  });

  it('非法输入返回 null', () => {
    expect(hexToRgb('')).toBeNull();
    expect(hexToRgb('#abc')).toBeNull();
    expect(hexToRgb('#gggggg')).toBeNull();
    expect(hexToRgb('rgb(1,2,3)')).toBeNull();
  });

  it('边界值往返不丢精度', () => {
    for (const value of ['#000000', '#ffffff', '#010203', '#fefdfc']) {
      expect(rgbToHex(hexToRgb(value)!)).toBe(value);
    }
  });

  it('越界通道在转回十六进制时被钳制', () => {
    expect(rgbToHex({ r: -5, g: 300, b: 128 })).toBe('#00ff80');
  });

  it('每个通道都补足两位', () => {
    expect(rgbToHex({ r: 0, g: 5, b: 10 })).toBe('#00050a');
  });
});

describe('parseColorInput', () => {
  it('解析六位写法', () => {
    expect(parseColorInput('#b4643f')).toEqual({ r: 180, g: 100, b: 63 });
    expect(parseColorInput('b4643f')).toEqual({ r: 180, g: 100, b: 63 });
  });

  it('解析三位简写', () => {
    expect(parseColorInput('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
    expect(parseColorInput('#f00')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('解析不了返回 null', () => {
    expect(parseColorInput('')).toBeNull();
    expect(parseColorInput('#ab')).toBeNull();
    expect(parseColorInput('红色')).toBeNull();
    expect(parseColorInput('#12345g')).toBeNull();
  });
});

describe('isValidHex', () => {
  it('区分合法与非法', () => {
    expect(isValidHex('#b4643f')).toBe(true);
    expect(isValidHex('#abc')).toBe(true);
    expect(isValidHex('#ab')).toBe(false);
    expect(isValidHex('')).toBe(false);
  });
});

describe('perceivedBrightness 与 readableTextColor', () => {
  it('白最亮、黑最暗', () => {
    expect(perceivedBrightness({ r: 255, g: 255, b: 255 })).toBeCloseTo(255, 0);
    expect(perceivedBrightness({ r: 0, g: 0, b: 0 })).toBe(0);
  });

  it('深色底给白字', () => {
    expect(readableTextColor('#4a7c8c')).toBe('#fffdf9');
    expect(readableTextColor('#000000')).toBe('#fffdf9');
  });

  it('浅色底给深字，避免白字糊在浅黄上', () => {
    expect(readableTextColor('#ffe680')).toBe('#3a352c');
    expect(readableTextColor('#ffffff')).toBe('#3a352c');
  });

  it('非法颜色时回退为白字，不抛错', () => {
    expect(readableTextColor('不是颜色')).toBe('#fffdf9');
  });
});

describe('channelGradient', () => {
  it('给出该通道 0→255 的渐变', () => {
    const gradient = channelGradient({ r: 180, g: 100, b: 63 }, 'r');
    expect(gradient).toBe('linear-gradient(to right, #00643f, #ff643f)');
  });

  it('三个通道各自独立', () => {
    const rgb = { r: 10, g: 20, b: 30 };
    expect(channelGradient(rgb, 'g')).toContain('#0a00 1e'.replace(' ', ''));
    expect(channelGradient(rgb, 'g')).not.toBe(channelGradient(rgb, 'b'));
  });
});
