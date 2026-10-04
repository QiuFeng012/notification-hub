import { describe, expect, it } from 'vitest';
import { PAGE_HASHES, pageFromHash } from '../src/lib/route';

describe('pageFromHash', () => {
  it('认得三种页面地址', () => {
    expect(pageFromHash('#/')).toBe('home');
    expect(pageFromHash('#/cards')).toBe('cards');
    expect(pageFromHash('#/settings')).toBe('settings');
  });

  it('容错：空 hash、缺斜杠、多余斜杠、大小写、前后空格都归一到同一页', () => {
    expect(pageFromHash('')).toBe('home');
    expect(pageFromHash('#')).toBe('home');
    expect(pageFromHash('#/')).toBe('home');
    expect(pageFromHash('#//')).toBe('home');
    expect(pageFromHash('#cards')).toBe('cards');
    expect(pageFromHash('#/Cards')).toBe('cards');
    expect(pageFromHash('#/cards/')).toBe('cards');
    expect(pageFromHash('  #/settings  ')).toBe('settings');
  });

  it('认不出来的一律回首页，而不是空白页或报错', () => {
    // 手打的地址、旧书签、别处粘来的链接都可能对不上，
    // 这几种情况下"回到首页"是唯一不会让人卡住的答案
    expect(pageFromHash('#/unknown')).toBe('home');
    expect(pageFromHash('#/cards/123')).toBe('home');
    expect(pageFromHash('#随便什么')).toBe('home');
    expect(pageFromHash('#/设置')).toBe('home');
  });

  it('每个页面的 hash 都能解析回自己（映射与解析必须成对）', () => {
    for (const [page, hash] of Object.entries(PAGE_HASHES)) {
      expect(pageFromHash(hash)).toBe(page);
    }
  });
});
