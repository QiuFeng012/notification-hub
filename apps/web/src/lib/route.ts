/**
 * 页面（视图）与地址栏 hash 的映射。
 *
 * 这是个单页应用，本来不需要路由；但这次把「首页」和「信息卡收集页」拆开了，
 * 没有任何 URL 状态会带来两个很具体的毛病：
 *   - 装成独立应用后，刷新或者重新点开图标永远回到首页，回不到你正在看的页面；
 *   - 浏览器后退键什么都不做。
 *
 * 所以只做最小的一件事：页面 ↔ hash 的双向映射。不引路由库，
 * 因为一共三个页面、没有嵌套、也没有参数。
 */
export type AppPage = 'home' | 'cards' | 'settings';

/** 每个页面在地址栏里的样子。用 hash 是因为服务端不需要配合。 */
export const PAGE_HASHES: Record<AppPage, string> = {
  home: '#/',
  cards: '#/cards',
  settings: '#/settings',
};

/**
 * 从 hash 解析页面。
 *
 * 认不出来的一律回首页，而不是报错或者停在空白页——
 * 手打的地址、旧书签、别处粘来的链接都可能对不上，
 * 这几种情况下"回到首页"是唯一不会让人卡住的答案。
 */
export function pageFromHash(hash: string): AppPage {
  const normalized = hash.trim().replace(/^#\/?/, '').replace(/\/+$/, '').toLowerCase();
  if (normalized === 'cards') return 'cards';
  if (normalized === 'settings') return 'settings';
  return 'home';
}

/** 当前地址对应的页面；读不到（隐私模式、异常环境）时回首页 */
export function readPageFromLocation(): AppPage {
  try {
    return pageFromHash(window.location.hash);
  } catch {
    return 'home';
  }
}

/**
 * 把页面写回地址栏。
 *
 * 赋 hash 而不是用 pushState：hash 变化本来就会产生一条历史记录，
 * 浏览器的后退键直接就能用，不需要自己维护历史栈。
 */
export function writePageToLocation(page: AppPage): void {
  try {
    const next = PAGE_HASHES[page];
    if (window.location.hash !== next) window.location.hash = next;
  } catch {
    // 写不进去只是丢掉地址栏状态，页面照常切换，不值得打断用户
  }
}
