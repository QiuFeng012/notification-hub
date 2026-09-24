import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createSettingsService, SettingsValidationError } from '../src/services/settings-service.js';
import { createSettingsStore } from '../src/settings/settings-store.js';

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempFilePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'notification-hub-svc-'));
  tempDirs.push(dir);
  return path.join(dir, 'settings.json');
}

interface ServiceOptions {
  filePath?: string;
  envApiKey?: string | null;
  fetchImpl: typeof fetch;
}

function makeService(options: ServiceOptions) {
  const filePath = options.filePath ?? tempFilePath();
  const store = createSettingsStore({
    filePath,
    envApiKey: options.envApiKey ?? null,
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
  });
  const service = createSettingsService({
    store,
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    validationTimeoutMs: 1000,
    fetchImpl: options.fetchImpl,
  });
  return { service, store, filePath };
}

function okFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"t","key_points":["a"]}' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
}

function statusFetch(status: number, body = 'error body'): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

describe('settings service 保存与验证', () => {
  it('Key 有效时保存成功且无告警', async () => {
    const { service } = makeService({ fetchImpl: okFetch() });
    const result = await service.update({ apiKey: 'sk-good-key-123456' });

    assert.equal(result.settings.configured, true);
    assert.equal(result.settings.source, 'user');
    assert.equal(result.warning, null);
  });

  it('Key 被拒（401）时抛 INVALID_API_KEY 且不落盘', async () => {
    const { service, filePath } = makeService({ fetchImpl: statusFetch(401, 'invalid api key') });

    await assert.rejects(
      () => service.update({ apiKey: 'sk-bad-key-123456' }),
      (error: unknown) => error instanceof SettingsValidationError && error.code === 'INVALID_API_KEY',
    );
    // 关键：验证失败不能留下已经被写进去的配置
    assert.equal(service.get().configured, false);
    assert.throws(() => readFileSync(filePath, 'utf8'), /ENOENT|no such file/);
  });

  it('Key 被拒（403）同样拒绝保存', async () => {
    const { service } = makeService({ fetchImpl: statusFetch(403) });
    await assert.rejects(
      () => service.update({ apiKey: 'sk-forbidden-123456' }),
      (error: unknown) => error instanceof SettingsValidationError && error.code === 'INVALID_API_KEY',
    );
  });

  it('网络异常时保存但给出告警，不假装验证通过', async () => {
    const { service } = makeService({
      fetchImpl: (async () => {
        throw new Error('socket hang up');
      }) as typeof fetch,
    });

    const result = await service.update({ apiKey: 'sk-unverifiable-1234' });
    assert.equal(result.settings.configured, true);
    assert.ok(result.warning, '应当有告警');
    assert.match(result.warning, /没能验证通过/);
    assert.match(result.warning, /socket hang up/);
  });

  it('限流（429）视为无法判定，仍然保存并告警', async () => {
    const { service } = makeService({ fetchImpl: statusFetch(429, 'rate limited') });
    const result = await service.update({ apiKey: 'sk-throttled-123456' });

    assert.equal(result.settings.configured, true);
    assert.match(result.warning ?? '', /429/);
  });

  it('只改 baseUrl 时也会用已有 Key 验证新地址', async () => {
    let calledUrl = '';
    const { service } = makeService({
      fetchImpl: (async (url: string | URL | Request) => {
        calledUrl = String(url);
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    });

    await service.update({ apiKey: 'sk-existing-123456' });
    calledUrl = '';
    await service.update({ baseUrl: 'https://proxy.example.com/v1' });

    // 验证必须打到新的地址，否则"只改地址"就绕过了验证
    assert.equal(calledUrl, 'https://proxy.example.com/v1/chat/completions');
  });

  it('只改 baseUrl 且新地址不可用时给出告警', async () => {
    let first = true;
    const { service } = makeService({
      fetchImpl: (async () => {
        if (first) {
          first = false;
          return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error('getaddrinfo ENOTFOUND proxy.example.com');
      }) as typeof fetch,
    });

    await service.update({ apiKey: 'sk-existing-123456' });
    const result = await service.update({ baseUrl: 'https://proxy.example.com/v1' });

    assert.ok(result.warning);
    assert.match(result.warning, /ENOTFOUND/);
    // 地址仍然被保存下来，用户可以自己判断要不要留着
    assert.equal(result.settings.baseUrl, 'https://proxy.example.com/v1');
  });

  it('没有 Key 时不做验证，直接保存', async () => {
    let called = false;
    const { service } = makeService({
      fetchImpl: (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });

    const result = await service.update({ baseUrl: 'https://proxy.example.com/v1' });
    assert.equal(called, false, '没有 Key 就不该发起模型调用');
    assert.equal(result.warning, null);
  });

  it('超长 Key 转成 VALUE_TOO_LONG 而不是 500', async () => {
    const { service } = makeService({ fetchImpl: okFetch() });
    await assert.rejects(
      () => service.update({ apiKey: 'x'.repeat(201) }),
      (error: unknown) => error instanceof SettingsValidationError && error.code === 'VALUE_TOO_LONG',
    );
  });

  it('清除后回到未配置', async () => {
    const { service } = makeService({ fetchImpl: okFetch() });
    await service.update({ apiKey: 'sk-clear-me-123456' });
    assert.equal(service.clear().configured, false);
  });

  it('环境变量 Key 也参与验证', async () => {
    let called = false;
    const { service } = makeService({
      envApiKey: 'sk-env-key-123456',
      fetchImpl: (async () => {
        called = true;
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    });

    // 改地址时会用 env 里的 Key 去验证，避免用户改出个连不上的地址还不知道
    await service.update({ baseUrl: 'https://proxy.example.com/v1' });
    assert.equal(called, true);
  });
});
