import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_STORAGE_KEY,
  applyTheme,
  isThemeMode,
  readStoredTheme,
  resolveTheme,
  writeStoredTheme,
} from '../src/lib/theme';

/**
 * 伪装系统深色偏好。
 *
 * jsdom 本身不实现 window.matchMedia，所以这里既是在提供测试替身，
 * 也是在确认"跟随系统"真的会去读系统偏好——而不是碰巧因为取不到就当浅色。
 */
function stubSystemDark(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal('matchMedia', vi.fn(() => query));
  /** 模拟用户在 Windows 里改了浅色/深色设置 */
  return function flip(next: boolean) {
    query.matches = next;
    for (const listener of listeners) listener();
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('主题偏好', () => {
  it('默认是跟随系统，而不是写死浅色', () => {
    expect(readStoredTheme()).toBe('system');
  });

  it('存进去能读回来', () => {
    writeStoredTheme('dark');
    expect(readStoredTheme()).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('存储里是坏值时退回默认，而不是把坏值当主题用', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, '紫罗兰');
    expect(readStoredTheme()).toBe('system');
  });

  it('isThemeMode 只认三种合法取值', () => {
    expect(isThemeMode('light')).toBe(true);
    expect(isThemeMode('dark')).toBe(true);
    expect(isThemeMode('system')).toBe(true);
    expect(isThemeMode('DARK')).toBe(false);
    expect(isThemeMode(null)).toBe(false);
    expect(isThemeMode('')).toBe(false);
  });
});

describe('resolveTheme', () => {
  it('明确选择的主题不受系统影响', () => {
    stubSystemDark(true);
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('跟随系统时按系统偏好解析', () => {
    stubSystemDark(true);
    expect(resolveTheme('system')).toBe('dark');
    stubSystemDark(false);
    expect(resolveTheme('system')).toBe('light');
  });

  it('取不到系统偏好时按浅色处理，而不是抛错', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => {
        throw new Error('被策略限制');
      }),
    );
    expect(() => resolveTheme('system')).not.toThrow();
    expect(resolveTheme('system')).toBe('light');
  });
});

describe('applyTheme', () => {
  it('把解析后的主题写到 html 上，并同时记下偏好模式', () => {
    stubSystemDark(true);
    writeStoredTheme('system');
    expect(applyTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    // 两个属性是不同的东西：一个是生效值，一个是用户选的那个
    expect(document.documentElement.getAttribute('data-theme-mode')).toBe('system');
  });

  it('明确选择深色时，系统是浅色也照样深色', () => {
    stubSystemDark(false);
    writeStoredTheme('dark');
    expect(applyTheme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('系统偏好变化时会自动重算（跟随系统时）', () => {
    const flip = stubSystemDark(false);
    writeStoredTheme('system');
    applyTheme();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    // 用户在 Windows 里切成深色
    flip(true);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    // 再切回浅色
    flip(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('明确选择了浅色时，系统切成深色也不会跟着变', () => {
    const flip = stubSystemDark(false);
    writeStoredTheme('light');
    applyTheme();
    flip(true);
    // 这是"明确选择"与"跟随系统"的关键区别：选了就不该被系统改掉
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('同步 theme-color，地址栏底色与应用背景保持一致', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);

    stubSystemDark(false);
    writeStoredTheme('dark');
    applyTheme();
    expect(meta.getAttribute('content')).toBe('#1a1916');

    writeStoredTheme('light');
    applyTheme();
    expect(meta.getAttribute('content')).toBe('#faf8f3');

    meta.remove();
  });

  it('没有 theme-color 标签时也不报错', () => {
    stubSystemDark(false);
    writeStoredTheme('dark');
    expect(() => applyTheme()).not.toThrow();
  });

  it('localStorage 抛异常时仍能按默认主题渲染', () => {
    stubSystemDark(false);
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('隐私模式不让读');
    });
    expect(() => applyTheme()).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
