import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSummarizerProvider, type EffectiveAiSettings } from '../src/ai/provider.js';

function okFetch(counter: { calls: number }): typeof fetch {
  return (async () => {
    counter.calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"t","key_points":["a"]}' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function makeSettings(overrides: Partial<EffectiveAiSettings> = {}): EffectiveAiSettings {
  return { apiKey: null, baseUrl: null, model: null, ...overrides };
}

describe('summarizer provider', () => {
  it('没有 Key 时给出本地启发式摘要器', async () => {
    let settings = makeSettings();
    const provider = createSummarizerProvider(() => settings);

    const result = await provider.get().summarize('请于3月8日前提交报名表，联系人张老师。');
    assert.equal(result.provider, 'mock');
  });

  it('填上 Key 后立刻切换为真实模型，无需重启', async () => {
    let settings = makeSettings();
    const counter = { calls: 0 };
    const provider = createSummarizerProvider(() => settings, { fetchImpl: okFetch(counter) });

    const before = await provider.get().summarize('随便一段通知');
    assert.equal(before.provider, 'mock');
    assert.equal(counter.calls, 0);

    // 模拟用户在界面上保存了 Key
    settings = makeSettings({ apiKey: 'sk-just-saved-123456' });

    const after = await provider.get().summarize('随便一段通知');
    assert.equal(after.provider, 'deepseek');
    assert.equal(counter.calls, 1);
  });

  it('设置没变时复用同一个摘要器实例（不重复构造客户端）', () => {
    const settings = makeSettings({ apiKey: 'sk-stable-123456' });
    const provider = createSummarizerProvider(() => settings, { fetchImpl: okFetch({ calls: 0 }) });

    assert.equal(provider.get(), provider.get());
  });

  it('设置变化后返回新的摘要器实例', () => {
    let settings = makeSettings({ apiKey: 'sk-first-123456' });
    const provider = createSummarizerProvider(() => settings, { fetchImpl: okFetch({ calls: 0 }) });

    const first = provider.get();
    settings = makeSettings({ apiKey: 'sk-second-123456' });
    assert.notEqual(provider.get(), first);
  });

  it('清空 Key 后回落为本地启发式摘要', async () => {
    let settings = makeSettings({ apiKey: 'sk-will-be-cleared-1' });
    const provider = createSummarizerProvider(() => settings, { fetchImpl: okFetch({ calls: 0 }) });
    assert.ok(provider.get().validate, '有 Key 时应当支持验证');

    settings = makeSettings();
    assert.equal(provider.get().validate, undefined, '无 Key 时是本地摘要器，不支持验证');
  });

  it('只改模型名也会切换摘要器', () => {
    let settings = makeSettings({ apiKey: 'sk-key-123456', model: 'deepseek-chat' });
    const provider = createSummarizerProvider(() => settings, { fetchImpl: okFetch({ calls: 0 }) });

    const first = provider.get();
    settings = makeSettings({ apiKey: 'sk-key-123456', model: 'deepseek-reasoner' });
    assert.notEqual(provider.get(), first);
  });

  it('用户配置的 baseUrl 会传给摘要器', async () => {
    let calledUrl = '';
    const provider = createSummarizerProvider(
      () => makeSettings({ apiKey: 'sk-key-123456', baseUrl: 'https://proxy.example.com/v1' }),
      {
        fetchImpl: (async (url: string | URL | Request) => {
          calledUrl = String(url);
          return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"t","key_points":["a"]}' } }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }) as typeof fetch,
      },
    );

    await provider.get().summarize('通知内容');
    assert.equal(calledUrl, 'https://proxy.example.com/v1/chat/completions');
  });
});
