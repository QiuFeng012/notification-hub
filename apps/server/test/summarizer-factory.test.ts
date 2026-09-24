import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSummarizer } from '../src/ai/index.js';

describe('createSummarizer', () => {
  it('没有 Key 时返回 mock 摘要器', async () => {
    const summarizer = createSummarizer({ apiKey: null });
    const result = await summarizer.summarize({ rawText: '请于3月8日前提交报名表，联系人张老师。', keywords: [] });
    assert.equal(result.provider, 'mock');
    assert.ok(result.draft.keyPoints.length > 0);
  });

  it('空字符串 Key 也视为未配置', async () => {
    const summarizer = createSummarizer({ apiKey: '   ' });
    const result = await summarizer.summarize({ rawText: '明天上午停水三小时，请提前储水。', keywords: [] });
    assert.equal(result.provider, 'mock');
  });

  it('有 Key 时走 DeepSeek，并把请求发到指定端点', async () => {
    let calledUrl = '';
    const summarizer = createSummarizer({
      apiKey: 'sk-test',
      baseUrl: 'https://example.test',
      fetchImpl: (async (url: string | URL | Request) => {
        calledUrl = String(url);
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"t","key_points":["a"]}' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    });

    const result = await summarizer.summarize({ rawText: '随便一段通知', keywords: [] });
    assert.equal(calledUrl, 'https://example.test/chat/completions');
    assert.equal(result.provider, 'deepseek');
  });
});
