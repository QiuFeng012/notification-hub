import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';

const MODULE_DIR = path.resolve(import.meta.dirname, '../src');

describe('loadConfig', () => {
  it('总是只监听回环地址，避免个人数据暴露到局域网', () => {
    const config = loadConfig({}, MODULE_DIR);
    assert.equal(config.host, '127.0.0.1');
  });

  it('未配置 Key 时 apiKey 为 null（触发 mock 模式）', () => {
    assert.equal(loadConfig({}, MODULE_DIR).deepseekApiKey, null);
    assert.equal(loadConfig({ DEEPSEEK_API_KEY: '   ' }, MODULE_DIR).deepseekApiKey, null);
  });

  it('Key 首尾空白被裁剪', () => {
    assert.equal(loadConfig({ DEEPSEEK_API_KEY: '  sk-abc  ' }, MODULE_DIR).deepseekApiKey, 'sk-abc');
  });

  it('默认端口为 5178', () => {
    assert.equal(loadConfig({}, MODULE_DIR).port, 5178);
  });

  it('非法端口回退到默认值', () => {
    assert.equal(loadConfig({ PORT: 'abc' }, MODULE_DIR).port, 5178);
    assert.equal(loadConfig({ PORT: '0' }, MODULE_DIR).port, 5178);
    assert.equal(loadConfig({ PORT: '99999' }, MODULE_DIR).port, 5178);
  });

  it('合法端口被采用', () => {
    assert.equal(loadConfig({ PORT: '6000' }, MODULE_DIR).port, 6000);
  });

  it('默认数据库路径位于仓库根的 data 目录', () => {
    const config = loadConfig({}, MODULE_DIR);
    assert.ok(config.dbPath.endsWith(path.join('data', 'cards.db')), config.dbPath);
    assert.ok(path.isAbsolute(config.dbPath));
  });

  it('DB_PATH 相对仓库根解析', () => {
    const config = loadConfig({ DB_PATH: 'tmp/custom.db' }, MODULE_DIR);
    assert.equal(config.dbPath, path.join(config.repoRoot, 'tmp', 'custom.db'));
  });

  it('默认模型与 baseUrl 指向 DeepSeek 官方', () => {
    const config = loadConfig({}, MODULE_DIR);
    assert.equal(config.deepseekModel, 'deepseek-chat');
    assert.equal(config.deepseekBaseUrl, 'https://api.deepseek.com');
  });

  it('可通过环境变量覆盖模型与 baseUrl', () => {
    const config = loadConfig(
      { DEEPSEEK_MODEL: 'deepseek-reasoner', DEEPSEEK_BASE_URL: 'https://proxy.test/v1' },
      MODULE_DIR,
    );
    assert.equal(config.deepseekModel, 'deepseek-reasoner');
    assert.equal(config.deepseekBaseUrl, 'https://proxy.test/v1');
  });

  it('web 构建目录指向 apps/web/dist', () => {
    const config = loadConfig({}, MODULE_DIR);
    assert.equal(config.webDistPath, path.join(config.repoRoot, 'apps', 'web', 'dist'));
  });
});
