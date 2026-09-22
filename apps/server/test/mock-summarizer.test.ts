import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMockSummarizer } from '../src/ai/mock-summarizer.js';
import { MAX_KEY_POINTS } from '../src/ai/types.js';

const summarizer = createMockSummarizer();

const NOTICE = `【教务处】各位同学：
本学期选课将于3月5日14:00开放，请于3月8日24:00前在教务系统完成选课，逾期系统自动关闭。
联系人：王老师 电话 12345678`;

describe('createMockSummarizer', () => {
  it('标记产出者为 mock', async () => {
    const result = await summarizer.summarize(NOTICE);
    assert.equal(result.provider, 'mock');
  });

  it('从方括号抬头识别来源', async () => {
    const { draft } = await summarizer.summarize(NOTICE);
    assert.equal(draft.source, '教务处');
  });

  it('识别 "来源：" 形式的来源', async () => {
    const { draft } = await summarizer.summarize('来源：后勤处\n停水通知：明天上午停水三小时。');
    assert.equal(draft.source, '后勤处');
  });

  it('识别日期', async () => {
    const { draft } = await summarizer.summarize(NOTICE);
    assert.ok(draft.time, '应识别出时间');
    assert.match(draft.time, /3\s*月\s*[58]\s*日/);
  });

  it('优先取截止时间而不是最先出现的开放时间', async () => {
    const { draft } = await summarizer.summarize(
      '选课将于3月5日14:00开放，请于3月8日24:00前完成选课，逾期系统自动关闭。',
    );
    assert.equal(draft.time, '3月8日24:00前');
  });

  it('截止时间与开放时间分处不同行时同样取截止时间', async () => {
    const { draft } = await summarizer.summarize(NOTICE);
    assert.equal(draft.time, '3月8日24:00前');
  });

  it('"前" 后不接动作词时不当作截止语义', async () => {
    const { draft } = await summarizer.summarize('请于3月5日前台签到并领取材料。');
    assert.equal(draft.time, '3月5日');
  });

  it('"前提" 等复合词不会被误判为截止', async () => {
    const { draft } = await summarizer.summarize('会议的前提条件是完成报名，时间为3月5日14:00。');
    assert.equal(draft.time, '3月5日14:00');
  });

  it('没有截止语义时取第一个出现的时间', async () => {
    const { draft } = await summarizer.summarize('会议定于3月5日14:00在第三会议室召开。');
    assert.equal(draft.time, '3月5日14:00');
  });

  it('没有日期时时间为 null', async () => {
    const { draft } = await summarizer.summarize('请大家记得把门关好，注意安全用电。');
    assert.equal(draft.time, null);
  });

  it('标题是完整句子而不是整段原文', async () => {
    const { draft } = await summarizer.summarize(NOTICE);
    assert.ok(!draft.title.includes('【'), `标题不应带方括号：${draft.title}`);
    assert.ok(draft.title.length <= 60);
    assert.ok(!draft.title.includes('\n'));
    assert.ok(!draft.title.endsWith('。'), `标题应去掉句末标点：${draft.title}`);
  });

  it('过滤掉寒暄类噪声行', async () => {
    const { draft } = await summarizer.summarize('收到\n谢谢\n请于3月8日前提交报名表，联系人张老师。');
    assert.ok(!draft.keyPoints.some((point) => point === '收到' || point === '谢谢'));
    assert.ok(draft.keyPoints.some((point) => point.includes('3月8日')));
  });

  it('要点数量不超过上限', async () => {
    const long = Array.from({ length: 30 }, (_, index) => `第${index}项需要你确认的注意事项`).join('\n');
    const { draft } = await summarizer.summarize(long);
    assert.ok(draft.keyPoints.length <= MAX_KEY_POINTS);
  });

  it('原文无有效信息时给出解释性要点', async () => {
    const { draft } = await summarizer.summarize('好的');
    assert.equal(draft.keyPoints.length, 1);
    assert.match(draft.keyPoints[0] ?? '', /未从原文中识别出有效要点/);
  });

  it('要点按重要性排序，含动作词的行优先', async () => {
    const { draft } = await summarizer.summarize(
      '今天天气不错，适合出门散步。\n请于3月8日24:00前提交报名表，逾期不再受理。',
    );
    assert.match(draft.keyPoints[0] ?? '', /3月8日/);
  });
});
