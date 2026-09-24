import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeKeywords, MAX_KEYWORDS, MAX_KEYWORD_LENGTH } from '@notification-hub/shared';
import { enforceKeywords } from '../src/keywords/keyword-check.js';
import { MAX_KEY_POINT_LENGTH } from '../src/ai/types.js';

describe('normalizeKeywords', () => {
  it('按中英文逗号、顿号、分号与空白拆分', () => {
    assert.deepEqual(normalizeKeywords('面试,报销、3 号楼;截止 next week'), [
      '面试',
      '报销',
      '3',
      '号楼',
      '截止',
      'next',
      'week',
    ]);
  });

  it('数组输入原样保留顺序', () => {
    assert.deepEqual(normalizeKeywords(['面试', '报销']), ['面试', '报销']);
  });

  it('去重且大小写不敏感，但保留首次出现的写法', () => {
    assert.deepEqual(normalizeKeywords(['Interview', 'interview', 'INTERVIEW']), ['Interview']);
  });

  it('丢弃空白项', () => {
    assert.deepEqual(normalizeKeywords(['  ', '面试', '']), ['面试']);
  });

  it('非字符串非数组输入返回空数组', () => {
    assert.deepEqual(normalizeKeywords(undefined), []);
    assert.deepEqual(normalizeKeywords(null), []);
    assert.deepEqual(normalizeKeywords(42), []);
    assert.deepEqual(normalizeKeywords({ a: 1 }), []);
  });

  it('数组里的非字符串项被丢弃', () => {
    assert.deepEqual(normalizeKeywords(['面试', 42, null, { a: 1 }, '报销']), ['面试', '报销']);
  });

  it('单个关键词超长会被截断', () => {
    const result = normalizeKeywords(['x'.repeat(100)]);
    assert.equal(result[0]?.length, MAX_KEYWORD_LENGTH);
  });

  it('数量上限生效', () => {
    const many = Array.from({ length: 50 }, (_, index) => `词${index}`);
    assert.equal(normalizeKeywords(many).length, MAX_KEYWORDS);
  });
});

describe('enforceKeywords 没有关注点', () => {
  it('原样返回要点，记录为空', () => {
    const result = enforceKeywords('原文', ['要点一'], []);
    assert.deepEqual(result.keyPoints, ['要点一']);
    assert.deepEqual(result.keywords, { priority: [], hit: [], missed: [] });
    assert.equal(result.supplemented, false);
  });
});

describe('enforceKeywords 命中判定', () => {
  it('要点已覆盖关键词时记为 hit，不加要点', () => {
    const result = enforceKeywords(
      '请于3月8日前提交报销单。',
      ['请于3月8日前提交报销单'],
      ['报销'],
    );

    assert.deepEqual(result.keywords.hit, ['报销']);
    assert.deepEqual(result.keywords.missed, []);
    assert.equal(result.supplemented, false);
    assert.equal(result.keyPoints.length, 1);
  });

  it('命中判定大小写不敏感', () => {
    const result = enforceKeywords('Please submit the REPORT.', ['Submit the Report'], ['report']);
    assert.deepEqual(result.keywords.hit, ['report']);
  });

  it('原文提到但要点没覆盖时标记为 missed 并补入证据句', () => {
    const rawText = '会议时间改到周五。报销材料请交到财务处。';
    const result = enforceKeywords(rawText, ['会议时间改到周五'], ['报销']);

    assert.deepEqual(result.keywords.missed, ['报销']);
    assert.equal(result.supplemented, true);
    assert.equal(result.keyPoints.length, 2);
    assert.ok(result.keyPoints[0]?.includes('报销材料请交到财务处'));
    assert.ok(result.keyPoints[0]?.startsWith('（关注点）'), '兜底要点要能一眼看出是补的');
  });

  it('兜底要点排在已有要点前面', () => {
    const result = enforceKeywords('第一件事。第二件关于报销。', ['第一件事'], ['报销']);
    assert.ok(result.keyPoints[0]?.includes('报销'));
    assert.equal(result.keyPoints[1], '第一件事');
  });

  it('原文根本没提的关键词不算遗漏，也不补垃圾', () => {
    const result = enforceKeywords('明天上午停水三小时。', ['明天上午停水三小时'], ['报销', '面试']);

    assert.deepEqual(result.keywords.missed, []);
    assert.deepEqual(result.keywords.hit, []);
    assert.equal(result.supplemented, false);
    assert.equal(result.keyPoints.length, 1);
  });

  it('同一个关键词不会被重复补入', () => {
    const result = enforceKeywords('关于报销的规定。', ['其他要点'], ['报销']);
    const fallbackCount = result.keyPoints.filter((point) => point.includes('报销')).length;
    assert.equal(fallbackCount, 1);
  });

  it('多个遗漏关键词各补一条', () => {
    const result = enforceKeywords('报销找财务。面试在周三。', ['无关要点'], ['报销', '面试']);

    assert.deepEqual(result.keywords.missed, ['报销', '面试']);
    assert.equal(result.keyPoints.length, 3);
  });

  it('证据句按句末标点切分，不会把整段塞进一条要点', () => {
    const rawText = '第一句无关内容。第二句提到报销流程。第三句也无关。';
    const result = enforceKeywords(rawText, [], ['报销']);
    const fallback = result.keyPoints[0] ?? '';

    assert.ok(fallback.includes('报销'));
    assert.ok(!fallback.includes('第一句'), '不该把前一句也带进来');
    assert.ok(!fallback.includes('第三句'), '不该把后一句也带进来');
  });

  it('证据句过长时被裁剪到要点长度上限内', () => {
    const longSentence = `报销${'相'.repeat(300)}`;
    const result = enforceKeywords(longSentence, [], ['报销']);

    assert.ok((result.keyPoints[0]?.length ?? 0) <= MAX_KEY_POINT_LENGTH);
  });

  it('部分命中部分遗漏时记录准确', () => {
    const rawText = '面试在周三。报销找财务。';
    const result = enforceKeywords(rawText, ['面试在周三'], ['面试', '报销']);

    assert.deepEqual(result.keywords.hit, ['面试']);
    assert.deepEqual(result.keywords.missed, ['报销']);
    assert.deepEqual(result.keywords.priority, ['面试', '报销']);
  });

  it('priority 原样记录用户填写的关注点', () => {
    const result = enforceKeywords('原文没有这些词。', [], ['面试', '报销']);
    assert.deepEqual(result.keywords.priority, ['面试', '报销']);
  });
});
