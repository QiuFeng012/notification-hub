import { describe, expect, it } from 'vitest';
import { MAX_KEYWORDS } from '@notification-hub/shared';
import { highlightSegments } from '../src/components/CardItem';
import { parseKeywordInput } from '../src/components/IngestForm';

describe('parseKeywordInput', () => {
  it('按中英文逗号、顿号、分号拆分', () => {
    expect(parseKeywordInput('面试,报销、3 号楼;截止')).toEqual(['面试', '报销', '3 号楼', '截止']);
  });

  it('裁剪首尾空白', () => {
    expect(parseKeywordInput('  面试  ,  报销 ')).toEqual(['面试', '报销']);
  });

  it('丢弃空项', () => {
    expect(parseKeywordInput('面试,,、,报销')).toEqual(['面试', '报销']);
  });

  it('去重且大小写不敏感，保留首次写法', () => {
    expect(parseKeywordInput('Report,report,REPORT')).toEqual(['Report']);
  });

  it('空输入返回空数组', () => {
    expect(parseKeywordInput('')).toEqual([]);
    expect(parseKeywordInput('   ,  、 ')).toEqual([]);
  });

  it('单个关键词超长时截断', () => {
    expect(parseKeywordInput('x'.repeat(50))[0]).toHaveLength(30);
  });
});

describe('highlightSegments', () => {
  it('没有关键词时原样返回一段', () => {
    expect(highlightSegments('报销材料请交到财务处', [])).toEqual([
      { text: '报销材料请交到财务处', hit: false },
    ]);
  });

  it('命中时切成 未命中/命中/未命中 三段', () => {
    expect(highlightSegments('报销材料请交到财务处', ['材料'])).toEqual([
      { text: '报销', hit: false },
      { text: '材料', hit: true },
      { text: '请交到财务处', hit: false },
    ]);
  });

  it('关键词在开头时没有前置空段', () => {
    expect(highlightSegments('报销材料', ['报销'])).toEqual([
      { text: '报销', hit: true },
      { text: '材料', hit: false },
    ]);
  });

  it('关键词在结尾时没有后置空段', () => {
    expect(highlightSegments('关于报销', ['报销'])).toEqual([
      { text: '关于', hit: false },
      { text: '报销', hit: true },
    ]);
  });

  it('同一关键词多次命中都被标出', () => {
    const segments = highlightSegments('报销再报销', ['报销']);
    expect(segments.filter((segment) => segment.hit)).toHaveLength(2);
  });

  it('多个关键词按出现位置排序', () => {
    const segments = highlightSegments('面试之后报销', ['报销', '面试']);
    expect(segments.map((segment) => segment.text)).toEqual(['面试', '之后', '报销']);
    expect(segments.map((segment) => segment.hit)).toEqual([true, false, true]);
  });

  it('位置相同时优先匹配更长的关键词', () => {
    const segments = highlightSegments('提交报销单据', ['报销', '报销单']);
    const hits = segments.filter((segment) => segment.hit).map((segment) => segment.text);
    expect(hits).toEqual(['报销单']);
  });

  it('原文没有的关键词不产生命中', () => {
    const segments = highlightSegments('停水通知', ['报销']);
    expect(segments).toEqual([{ text: '停水通知', hit: false }]);
  });

  it('关键词含正则特殊字符也不会出错', () => {
    // 用正则实现会在这里炸掉或被当成元字符，所以实现必须是纯字符串切分
    const segments = highlightSegments('费用 (报销) 流程', ['(报销)']);
    expect(segments.some((segment) => segment.hit && segment.text === '(报销)')).toBe(true);
  });

  it('关键词为空字符串时被忽略', () => {
    expect(highlightSegments('通知', [''])).toEqual([{ text: '通知', hit: false }]);
  });

  it('切分结果拼起来等于原文，不会丢字符', () => {
    const text = '面试之后报销，最后提交报销单据';
    const segments = highlightSegments(text, ['报销', '面试', '报销单']);
    expect(segments.map((segment) => segment.text).join('')).toBe(text);
  });

  it('关键词数量上限不影响切分正确性', () => {
    const text = '甲和乙';
    const many = Array.from({ length: MAX_KEYWORDS }, (_, index) => `词${index}`).concat('甲');
    expect(highlightSegments(text, many).some((segment) => segment.hit)).toBe(true);
  });
});
