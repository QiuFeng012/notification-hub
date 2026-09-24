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

/** 调用包装：多数用例不关心关键词，统一按"没有关注点"传 */
function summarizeText(summarizer: ReturnType<typeof createDeepSeekSummarizer>, rawText: string) {
  return summarizer.summarize({ rawText, keywords: [] });
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

    await summarizeText(summarizer, NOTICE);

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

    const result = await summarizeText(summarizer, NOTICE);
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
      () => summarizeText(summarizer, NOTICE),
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

    await assert.rejects(() => summarizeText(summarizer, NOTICE), /调用 DeepSeek 失败.*socket hang up/);
  });

  it('响应内容不是 JSON 时退化成占位要点而不崩', async () => {
    const summarizer = createDeepSeekSummarizer({
      apiKey: 'k',
      fetchImpl: (async () => completion('抱歉，我无法处理。')) as typeof fetch,
    });

    const result = await summarizeText(summarizer, NOTICE);
    assert.equal(result.draft.keyPoints.length, 1);
    assert.match(result.draft.keyPoints[0] ?? '', /占位/);
  });

  it('choices 为空时同样退化成占位要点', async () => {
    const summarizer = createDeepSeekSummarizer({
      apiKey: 'k',
      fetchImpl: (async () => jsonResponse({})) as typeof fetch,
    });

    const result = await summarizeText(summarizer, NOTICE);
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

    await assert.rejects(() => summarizeText(summarizer, NOTICE), /超时/);
  });
});

describe('createDeepSeekSummarizer 传递关注点', () => {
  function captureUserMessage(): { get: () => string; summarizer: ReturnType<typeof createDeepSeekSummarizer> } {
    let captured = '';
    const summarizer = createDeepSeekSummarizer({
      apiKey: 'k',
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{ role: string; content: string }>;
        };
        captured = body.messages[1]?.content ?? '';
        return completion('{"title":"t","key_points":["a"]}');
      }) as typeof fetch,
    });
    return { get: () => captured, summarizer };
  }

  it('有关注点时，关注点与原文一并进入请求', async () => {
    const { get, summarizer } = captureUserMessage();
    await summarizer.summarize({ rawText: NOTICE, keywords: ['面试', '报销'] });

    const message = get();
    assert.match(message, /用户本次特别关注/);
    assert.match(message, /面试/);
    assert.match(message, /报销/);
    // 原文必须还在，且关键词说明在原文之前
    assert.ok(message.includes(NOTICE), '原文必须完整传给模型');
    assert.ok(
      message.indexOf('用户本次特别关注') < message.indexOf(NOTICE),
      '关注点说明应在原文之前',
    );
    assert.match(message, /至少有一条要点必须覆盖它/);
    assert.match(message, /不要为了凑数而推测或编造/);
  });

  it('没有关注点时，请求里只有原文，不出现关注点段落', async () => {
    const { get, summarizer } = captureUserMessage();
    await summarizer.summarize({ rawText: NOTICE, keywords: [] });

    assert.equal(get(), NOTICE);
  });

  it('system 提示不因关注点而变化（保住上下文缓存）', async () => {
    const systemPrompts: string[] = [];
    const makeSummarizer = () =>
      createDeepSeekSummarizer({
        apiKey: 'k',
        fetchImpl: (async (_url: unknown, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as {
            messages: Array<{ role: string; content: string }>;
          };
          systemPrompts.push(body.messages[0]?.content ?? '');
          return completion('{"title":"t","key_points":["a"]}');
        }) as typeof fetch,
      });

    await makeSummarizer().summarize({ rawText: NOTICE, keywords: [] });
    await makeSummarizer().summarize({ rawText: NOTICE, keywords: ['面试'] });

    assert.equal(systemPrompts.length, 2);
    assert.equal(systemPrompts[0], systemPrompts[1], 'system 提示必须逐字一致，否则缓存失效');
  });
});
