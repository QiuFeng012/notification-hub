import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDeepSeekSummarizer } from '../src/ai/deepseek-summarizer.js';
import { SummaryError } from '../src/ai/types.js';

const NOTICE = '【教务处】选课将于3月5日14:00开放，请于3月8日24:00前完成选课。';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function completion(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

describe('createDeepSeekSummarizer', () => {
  it('调用正确的端点、模型与鉴权头', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    const summarizer = createDeepSeekSummarizer({
      apiKey: 'test-key',
      baseUrl: 'https://example.test/',
      model: 'deepseek-chat',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedInit = init;
        return completion('{"title":"t","key_points":["a"]}');
      }) as typeof fetch,
    });

    await summarizer.summarize(NOTICE);

    // baseUrl 末尾斜杠应被规范化，避免出现双斜杠
    assert.equal(capturedUrl, 'https://example.test/chat/completions');
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer test-key');

    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
    assert.equal(body.model, 'deepseek-chat');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.stream, false);
    const messages = body.messages as Array<{ role: string; content: string }>;
    assert.match(messages[0]?.content ?? '', /只输出 JSON/);
    assert.equal(messages[1]?.content, NOTICE);
  });

  it('解析模型返回的 JSON 并标记 provider 为 deepseek', async () => {
    const summarizer = createDeepSeekSummarizer({
      apiKey: 'k',
      fetchImpl: (async () =>
        completion(
          '{"title":"选课通知","time":"3月8日24:00前","source":"教务处","key_points":["3月5日开放"]}',
        )) as typeof fetch,
    });

    const result = await summarizer.summarize(NOTICE);
    assert.equal(result.provider, 'deepseek');
    assert.equal(result.draft.title, '选课通知');
    assert.equal(result.draft.source, '教务处');
  });

  it('接口报错时抛出带状态码的 SummaryError', async () => {
    const summarizer = createDeepSeekSummarizer({
      apiKey: 'k',
      fetchImpl: (async () => new Response('invalid api key', { status: 401 })) as typeof fetch,
    });

    await assert.rejects(
      () => summarizer.summarize(NOTICE),
      (error: unknown) => {
        assert.ok(error instanceof SummaryError);
        assert.match(error.message, /401/);
        assert.match(error.message, /invalid api key/);
        return true;
      },
    );
  });

  it('网络异常时抛出可读错误', async () => {
    const summarizer = createDeepSeekSummarizer({
      apiKey: 'k',
      fetchImpl: (async () => {
        throw new Error('socket hang up');
      }) as typeof fetch,
    });

    await assert.rejects(() => summarizer.summarize(NOTICE), /调用 DeepSeek 失败.*socket hang up/);
  });

  it('响应内容不是 JSON 时退化成占位要点而不崩', async () => {
    const summarizer = createDeepSeekSummarizer({
      apiKey: 'k',
      fetchImpl: (async () => completion('抱歉，我无法处理。')) as typeof fetch,
    });

    const result = await summarizer.summarize(NOTICE);
    assert.equal(result.draft.keyPoints.length, 1);
    assert.match(result.draft.keyPoints[0] ?? '', /占位/);
  });

  it('choices 为空时同样退化成占位要点', async () => {
    const summarizer = createDeepSeekSummarizer({
      apiKey: 'k',
      fetchImpl: (async () => jsonResponse({})) as typeof fetch,
    });

    const result = await summarizer.summarize(NOTICE);
    assert.match(result.draft.keyPoints[0] ?? '', /占位/);
  });

  it('超时抛出明确的超时错误', async () => {
    const summarizer = createDeepSeekSummarizer({
      apiKey: 'k',
      timeoutMs: 10,
      fetchImpl: ((_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })) as typeof fetch,
    });

    await assert.rejects(() => summarizer.summarize(NOTICE), /超时/);
  });
});
