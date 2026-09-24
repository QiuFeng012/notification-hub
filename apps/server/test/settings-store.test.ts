import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createSettingsStore, maskApiKey } from '../src/settings/settings-store.js';

const tempDirs: string[] = [];

function tempFilePath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'notification-hub-settings-'));
  tempDirs.push(dir);
  return path.join(dir, 'settings.json');
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeStore(options: { filePath?: string; envApiKey?: string | null } = {}) {
  return createSettingsStore({
    filePath: options.filePath ?? tempFilePath(),
    envApiKey: options.envApiKey ?? null,
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
  });
}

describe('maskApiKey', () => {
  it('长 Key 保留头尾，中间打点', () => {
    assert.equal(maskApiKey('sk-1234567890abcdef'), 'sk-123…cdef');
  });

  it('短 Key 只留前两个字符，其余打点', () => {
    assert.equal(maskApiKey('abcd'), 'ab**');
    assert.equal(maskApiKey('ab'), 'ab*');
    // 再短就只剩一个字符加一个点，也不会空
    assert.equal(maskApiKey('a'), 'a*');
  });

  it('空字符串返回空', () => {
    assert.equal(maskApiKey(''), '');
    assert.equal(maskApiKey('   '), '');
  });

  it('掩码远短于原文，不会泄漏大部分内容', () => {
    const key = 'sk-' + 'x'.repeat(120);
    assert.ok(maskApiKey(key).length < 20);
  });
});

describe('settings store 解析优先级', () => {
  it('什么都没有时是 mock', () => {
    const store = makeStore();
    assert.deepEqual(store.resolve(), { apiKey: null, baseUrl: null, model: null, source: 'mock' });
    assert.equal(store.view().configured, false);
    assert.equal(store.view().source, 'mock');
  });

  it('有环境变量 Key 时用 env', () => {
    const store = makeStore({ envApiKey: 'sk-env-1234567890' });
    assert.equal(store.resolve().source, 'env');
    assert.equal(store.resolve().apiKey, 'sk-env-1234567890');
  });

  it('用户保存的 Key 优先于环境变量', () => {
    const store = makeStore({ envApiKey: 'sk-env-1234567890' });
    store.save({ apiKey: 'sk-user-0987654321' });
    assert.equal(store.resolve().source, 'user');
    assert.equal(store.resolve().apiKey, 'sk-user-0987654321');
  });

  it('用户只设了 baseUrl 而没有 Key 时，仍然算 mock', () => {
    const store = makeStore();
    store.save({ baseUrl: 'https://proxy.test/v1' });
    // 没有 Key，模型调用无从谈起，所以不该声称已配置
    assert.equal(store.view().source, 'mock');
    assert.equal(store.view().configured, false);
    // 但地址要记住，等填入 Key 时就用它
    assert.equal(store.view().baseUrl, 'https://proxy.test/v1');
  });
});

describe('settings store 读写', () => {
  it('保存后能读回', () => {
    const filePath = tempFilePath();
    const first = makeStore({ filePath });
    first.save({ apiKey: 'sk-persisted-key-1234', model: 'deepseek-reasoner' });

    // 换一个实例读同一个文件，模拟服务重启
    const second = makeStore({ filePath });
    assert.equal(second.resolve().apiKey, 'sk-persisted-key-1234');
    assert.equal(second.resolve().model, 'deepseek-reasoner');
    assert.equal(second.hasUserConfig(), true);
  });

  it('保存时会裁剪首尾空白', () => {
    const store = makeStore();
    store.save({ apiKey: '  sk-padded-key-1234  ' });
    assert.equal(store.resolve().apiKey, 'sk-padded-key-1234');
  });

  it('clear 后回到 mock', () => {
    const store = makeStore();
    store.save({ apiKey: 'sk-something-123456' });
    store.clear();
    assert.equal(store.view().configured, false);
    assert.equal(store.hasUserConfig(), false);
  });

  it('部分更新不会抹掉其他字段', () => {
    const store = makeStore();
    store.save({ apiKey: 'sk-keep-me-123456', baseUrl: 'https://proxy.test/v1' });
    store.save({ model: 'deepseek-reasoner' });

    const resolved = store.resolve();
    assert.equal(resolved.apiKey, 'sk-keep-me-123456');
    assert.equal(resolved.baseUrl, 'https://proxy.test/v1');
    assert.equal(resolved.model, 'deepseek-reasoner');
  });

  it('apiKey 传空字符串等于清除', () => {
    const store = makeStore();
    store.save({ apiKey: 'sk-remove-me-123456' });
    store.save({ apiKey: '' });
    assert.equal(store.resolve().apiKey, null);
  });
});

describe('settings store 视图与安全', () => {
  it('视图只给掩码，不给完整 Key', () => {
    const store = makeStore();
    store.save({ apiKey: 'sk-secret-value-abcdef' });
    const view = store.view();

    assert.equal(JSON.stringify(view).includes('sk-secret-value-abcdef'), false);
    assert.equal(view.apiKeyMask, 'sk-sec…cdef');
  });

  it('文件里确实是明文存储，但位于被 gitignore 的 data 目录下', () => {
    const filePath = tempFilePath();
    const store = makeStore({ filePath });
    store.save({ apiKey: 'sk-plaintext-123456' });

    const raw = readFileSync(filePath, 'utf8');
    assert.ok(raw.includes('sk-plaintext-123456'), '本机个人应用按设计明文存储，依赖文件权限');
  });

  it('非 Windows 平台下文件权限收紧到 600', { skip: process.platform === 'win32' }, () => {
    const filePath = tempFilePath();
    const store = makeStore({ filePath });
    store.save({ apiKey: 'sk-perm-check-123456' });

    const mode = statSync(filePath).mode & 0o777;
    assert.equal(mode, 0o600, `实际权限 ${mode.toString(8)}`);
  });
});

describe('settings store 容错', () => {
  it('文件损坏时按未配置处理，不抛错', () => {
    const filePath = tempFilePath();
    writeFileSync(filePath, '{ 这不是合法 JSON', 'utf8');
    const store = makeStore({ filePath });

    assert.equal(store.resolve().source, 'mock');
    assert.equal(store.view().configured, false);
  });

  it('文件内容是数组等非对象时也不抛错', () => {
    const filePath = tempFilePath();
    writeFileSync(filePath, '[1,2,3]', 'utf8');
    assert.equal(makeStore({ filePath }).resolve().source, 'mock');
  });

  it('超长 Key 被拒绝写入', () => {
    const store = makeStore();
    assert.throws(() => store.save({ apiKey: 'x'.repeat(201) }), /过长/);
    // 拒绝之后不应留下半截配置
    assert.equal(store.resolve().apiKey, null);
  });

  it('超长 baseUrl 与模型名同样被拒绝', () => {
    const store = makeStore();
    assert.throws(() => store.save({ baseUrl: `https://${'a'.repeat(300)}` }), /过长/);
    assert.throws(() => store.save({ model: 'm'.repeat(101) }), /过长/);
  });
});
