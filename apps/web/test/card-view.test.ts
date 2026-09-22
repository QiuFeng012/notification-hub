import { describe, expect, it } from 'vitest';
import { formatRelative, formatTimestamp, toCardView } from '../src/lib/card-view';

const VALID_CARD = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  title: '选课开放通知',
  time: '3月8日24:00前',
  source: '教务处',
  keyPoints: ['3月5日14:00开放选课', '3月8日24:00前完成'],
  rawText: '【教务处】原文',
  provider: 'deepseek',
  createdAt: '2025-03-05T06:32:00.000Z',
};

describe('toCardView', () => {
  it('完整字段被正确映射', () => {
    const view = toCardView(VALID_CARD);
    expect(view).not.toBeNull();
    expect(view?.title).toBe('选课开放通知');
    expect(view?.source).toBe('教务处');
    expect(view?.provider).toBe('deepseek');
    expect(view?.keyPoints).toHaveLength(2);
  });

  it('缺少 id 时返回 null，避免渲染出无法操作的空卡片', () => {
    expect(toCardView({ ...VALID_CARD, id: undefined })).toBeNull();
    expect(toCardView({ ...VALID_CARD, id: '' })).toBeNull();
    expect(toCardView(null)).toBeNull();
    expect(toCardView('字符串')).toBeNull();
  });

  it('title 缺失时回退为占位标题', () => {
    expect(toCardView({ ...VALID_CARD, title: '   ' })?.title).toBe('未命名通知');
  });

  it('time / source 为空字符串或 null 时归一化为 null', () => {
    const view = toCardView({ ...VALID_CARD, time: '', source: null });
    expect(view?.time).toBeNull();
    expect(view?.source).toBeNull();
  });

  it('keyPoints 非数组时降级为空数组而不是崩溃', () => {
    expect(toCardView({ ...VALID_CARD, keyPoints: '不是数组' })?.keyPoints).toEqual([]);
    expect(toCardView({ ...VALID_CARD, keyPoints: undefined })?.keyPoints).toEqual([]);
  });

  it('keyPoints 中的非字符串项被过滤', () => {
    const view = toCardView({ ...VALID_CARD, keyPoints: ['有效', 42, null, '  ', '也有效'] });
    expect(view?.keyPoints).toEqual(['有效', '也有效']);
  });

  it('未知 provider 归一到 mock，避免界面误标为 AI 生成', () => {
    expect(toCardView({ ...VALID_CARD, provider: 'openai' })?.provider).toBe('mock');
    expect(toCardView({ ...VALID_CARD, provider: undefined })?.provider).toBe('mock');
  });

  it('rawText 缺失时为空字符串，查看原文不会显示 undefined', () => {
    expect(toCardView({ ...VALID_CARD, rawText: undefined })?.rawText).toBe('');
  });
});

describe('formatTimestamp', () => {
  it('格式化为 YYYY-MM-DD HH:mm', () => {
    // 使用无时区后缀的本地时间字符串，避免测试结果随运行环境时区变化
    expect(formatTimestamp('2025-03-05T14:32:00')).toBe('2025-03-05 14:32');
  });

  it('个位数月日时分补零', () => {
    expect(formatTimestamp('2025-01-02T03:04:00')).toBe('2025-01-02 03:04');
  });

  it('非法输入有可读回退', () => {
    expect(formatTimestamp(undefined)).toBe('时间未知');
    expect(formatTimestamp('不是时间')).toBe('不是时间');
  });
});

describe('formatRelative', () => {
  const now = new Date('2025-03-05T12:00:00').getTime();

  it('一分钟内显示"刚刚"', () => {
    expect(formatRelative('2025-03-05T11:59:30', now)).toBe('刚刚');
  });

  it('分钟 / 小时 / 天三档', () => {
    expect(formatRelative('2025-03-05T11:30:00', now)).toBe('30 分钟前');
    expect(formatRelative('2025-03-05T09:00:00', now)).toBe('3 小时前');
    expect(formatRelative('2025-03-03T12:00:00', now)).toBe('2 天前');
  });

  it('超过 7 天回退成完整日期', () => {
    expect(formatRelative('2025-02-01T12:00:00', now)).toBe('2025-02-01 12:00');
  });

  it('空值返回"时间未知"', () => {
    expect(formatRelative(null, now)).toBe('时间未知');
    expect(formatRelative('', now)).toBe('时间未知');
  });
});
