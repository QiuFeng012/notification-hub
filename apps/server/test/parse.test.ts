import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { coerceDraft, extractJsonObject, parseSummaryResponse, truncate } from '../src/ai/parse.js';
import { MAX_KEY_POINTS } from '../src/ai/types.js';

const NOTICE = `【教务处】各位同学：本学期选课将于3月5日14:00开放，
请于3月8日24:00前在教务系统完成选课，逾期系统自动关闭。`;

describe('truncate', () => {
  it('压缩空白并保持短文本原样', () => {
    assert.equal(truncate('  多个   空格  ', 50), '多个 空格');
  });

  it('超长文本截断并补省略号', () => {
    const result = truncate('一'.repeat(100), 10);
    assert.equal(result.length, 10);
    assert.ok(result.endsWith('…'));
  });
});

describe('extractJsonObject', () => {
  it('解析纯 JSON', () => {
    assert.deepEqual(extractJsonObject('{"title":"a"}'), { title: 'a' });
  });

  it('解析被 ```json 代码块包裹的 JSON', () => {
    assert.deepEqual(extractJsonObject('```json\n{"title":"a"}\n```'), { title: 'a' });
  });

  it('解析前后带解释文字的 JSON', () => {
    assert.deepEqual(extractJsonObject('好的，结果如下：\n{"title":"a"}\n以上。'), { title: 'a' });
  });

  it('内容为空时抛出可读错误', () => {
    assert.throws(() => extractJsonObject('   '), /空内容/);
  });

  it('完全没有 JSON 时抛出可读错误', () => {
    assert.throws(() => extractJsonObject('这里没有任何结构化数据'), /不是合法 JSON/);
  });
});

describe('coerceDraft', () => {
  it('规整正常结构', () => {
    const draft = coerceDraft({
      title: '选课通知',
      time: '3月8日24:00前',
      source: '教务处',
      key_points: ['A', 'B'],
    });
    assert.deepEqual(draft, {
      title: '选课通知',
      time: '3月8日24:00前',
      source: '教务处',
      keyPoints: ['A', 'B'],
    });
  });

  it('把占位文本当成"未识别"', () => {
    const draft = coerceDraft({ title: 't', time: 'null', source: '未知', key_points: ['A'] });
    assert.equal(draft?.time, null);
    assert.equal(draft?.source, null);
  });

  it('key_points 为字符串时按行拆分', () => {
    const draft = coerceDraft({ title: 't', key_points: '第一点\n第二点' });
    assert.deepEqual(draft?.keyPoints, ['第一点', '第二点']);
  });

  it('要点超过上限时裁剪', () => {
    const draft = coerceDraft({
      title: 't',
      key_points: Array.from({ length: 20 }, (_, index) => `要点${index}`),
    });
    assert.equal(draft?.keyPoints.length, MAX_KEY_POINTS);
  });

  it('没有可用要点时返回 null', () => {
    assert.equal(coerceDraft({ title: 't', key_points: [] }), null);
    assert.equal(coerceDraft({ title: 't', key_points: '  ' }), null);
  });

  it('标题缺失时用第一条要点兜底', () => {
    const draft = coerceDraft({ key_points: ['唯一要点'] });
    assert.equal(draft?.title, '唯一要点');
  });

  it('输入不是对象时返回 null', () => {
    assert.equal(coerceDraft(null), null);
    assert.equal(coerceDraft('字符串'), null);
    assert.equal(coerceDraft(42), null);
  });
});

describe('parseSummaryResponse', () => {
  it('从模型回复中还原草稿', () => {
    const draft = parseSummaryResponse(
      '{"title":"选课通知","time":"3月8日24:00前","source":"教务处","key_points":["3月5日开放","3月8日前完成"]}',
      NOTICE,
    );
    assert.equal(draft.title, '选课通知');
    assert.equal(draft.keyPoints.length, 2);
  });

  it('JSON 损坏时退化成占位草稿而不是抛错', () => {
    const draft = parseSummaryResponse('{这不是 JSON', NOTICE);
    assert.ok(draft.title.length > 0);
    assert.equal(draft.keyPoints.length, 1);
    assert.match(draft.keyPoints[0] ?? '', /占位/);
  });

  it('JSON 合法但缺要点时退化成占位草稿', () => {
    const draft = parseSummaryResponse('{"title":"只有标题"}', NOTICE);
    assert.match(draft.keyPoints[0] ?? '', /缺少有效要点/);
  });

  it('占位草稿的标题取自原文首行', () => {
    const draft = parseSummaryResponse('', NOTICE);
    assert.match(draft.title, /教务处/);
  });
});
