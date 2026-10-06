/**
 * 主题（外观风格）。
 *
 * 三种偏好：米白、深色、跟随系统。前两个是明确选择，"跟随系统"则在应用侧
 * 就被解析成前两者之一——所以 `<html>` 上的 data-theme 永远只有 light / dark
 * 两个取值，CSS 里不需要写 media query，也不会出现"CSS 与 JS 各判一次
 * 系统偏好、结果不一致"的情况。
 *
 * 存储只落在 localStorage，没有走服务端设置：这是纯显示偏好，
 * 和已有的排序方式、卡片视图是同一类东西（见 App.tsx 里的 readStoredSortMode）。
 * 为此每次点一下都去写一次 data/settings.json 不值得，也会让"设置已保存"
 * 的提示语义变得含糊。
 */

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_MODES: readonly ThemeMode[] = ['light', 'dark', 'system'];

export const THEME_LABELS: Record<ThemeMode, string> = {
  light: '米白',
  dark: '深色',
  system: '跟随系统',
};

/** 每个模式在界面上的补充说明：光有名字看不出"跟随系统"跟的是什么 */
export const THEME_DESCRIPTIONS: Record<ThemeMode, string> = {
  light: '暖白纸面，白天与明亮环境下最省眼',
  dark: '暖黑背景，夜里看不刺眼',
  system: '跟着 Windows 的浅色/深色设置自动切换',
};

/**
 * 存储键。**这个字符串在 apps/web/index.html 的内联脚本里也出现了一次**
 * （那段脚本必须早于打包产物执行，否则会先渲染一帧浅色再变深色，也就是闪白）。
 * 改这里就要同步改那里，两处不一致的表现是"打开时闪一下"。
 */
export const THEME_STORAGE_KEY = 'notification-hub.theme';

/** 深色主题下浏览器地址栏/状态栏的底色，与 --bg 保持一致 */
const THEME_COLORS: Record<ThemeMode, string> = {
  dark: '#1a1916',
  light: '#faf8f3',
  system: '#faf8f3',
};

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

/** 系统当前是不是深色。取不到（老浏览器、被策略限制）时按浅色处理。 */
export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/** 把偏好解析成真正生效的主题 */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

/**
 * 读本地偏好。localStorage 在隐私模式或跨域 iframe 里会直接抛异常，
 * 所以整段包在 try 里——读不出来只是回到默认值，不该让界面白屏。
 * 默认 'system'：这是新装应用时最不意外的行为。
 */
export function readStoredTheme(): ThemeMode {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

/** 存本地偏好。存不下就只当次生效，不值得为此打断用户。 */
export function writeStoredTheme(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 同上
  }
}

/**
 * 应用主题：写 data-theme、同步 theme-color、同步系统偏好监听。
 *
 * 每次都从 localStorage 重新读偏好，而不是接收一个 mode 参数——
 * 这样"系统主题变了"和"用户改了偏好"可以走同一条路：
 * 偏好是「跟随系统」时重新解析，是明确选择时保持不变。
 *
 * @returns 真正生效的主题，供调用方更新界面状态
 */
export function applyTheme(): 'light' | 'dark' {
  const mode = readStoredTheme();
  const resolved = resolveTheme(mode);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  // 偏好模式也写上去：设置页里每个选项的小样要按**它自己的**模式渲染，
  // 而"跟随系统"的小样必须跟着当前生效值走。两者是不同的东西，所以要两个属性。
  root.setAttribute('data-theme-mode', mode);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[resolved]);

  watchSystemTheme();
  return resolved;
}

/**
 * 系统偏好监听。
 *
 * 只在**当前这个 matchMedia 对象**上挂一次，而不是用一个"全局只挂一次"的布尔量：
 * 后者在测试里会出问题——每个用例都换一个新的 matchMedia 替身，而布尔量还记着
 * "已经挂过了"，于是监听留在上一个替身上，系统变化再也传不过来
 * （这条是被 theme.test.ts 里"系统偏好变化时自动重算"抓出来的）。
 *
 * 另外注意：改变量只在模块内使用，不导出——外面只需要调 applyTheme。
 */
let watchedQuery: MediaQueryList | null = null;
let watchedListener: (() => void) | null = null;

function watchSystemTheme(): void {
  try {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    if (query === watchedQuery) return;

    // 换对象前先摘掉旧的，避免在旧对象上留下永远收不到事件的引用
    if (watchedQuery && watchedListener) {
      if (typeof watchedQuery.removeEventListener === 'function') {
        watchedQuery.removeEventListener('change', watchedListener);
      } else if (typeof (watchedQuery as MediaQueryList).removeListener === 'function') {
        (watchedQuery as MediaQueryList).removeListener(watchedListener);
      }
    }

    // 每次重新读偏好再应用："跟随系统"要跟着变，明确选择的不受影响——
    // 这个判断在 applyTheme 里，所以这里不必区分
    const listener = () => {
      applyTheme();
    };
    if (typeof query.addEventListener === 'function') query.addEventListener('change', listener);
    else if (typeof (query as MediaQueryList).addListener === 'function') {
      (query as MediaQueryList).addListener(listener);
    }

    watchedQuery = query;
    watchedListener = listener;
  } catch {
    // 拿不到系统偏好就只按当前解析结果生效，不监听
  }
}
