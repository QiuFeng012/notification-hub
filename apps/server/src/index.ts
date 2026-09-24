import { createSummarizerProvider } from './ai/provider.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createSqliteCardRepository } from './db/sqlite-repository.js';
import { createCardService } from './services/card-service.js';
import { createSettingsService } from './services/settings-service.js';
import { createSettingsStore } from './settings/settings-store.js';

const config = loadConfig();

const repo = createSqliteCardRepository(config.dbPath);

// 设置是运行时可变的：用户在界面上填 Key 后立刻生效，不需要重启进程。
// 因此摘要器通过 Provider 按当前设置动态取用。
const settingsStore = createSettingsStore({
  filePath: config.settingsPath,
  envApiKey: config.deepseekApiKey,
  defaultBaseUrl: config.deepseekBaseUrl,
  defaultModel: config.deepseekModel,
});

const summarizerProvider = createSummarizerProvider(
  () => {
    const resolved = settingsStore.resolve();
    return { apiKey: resolved.apiKey, baseUrl: resolved.baseUrl, model: resolved.model };
  },
  { timeoutMs: config.aiTimeoutMs },
);

const cardService = createCardService(repo, summarizerProvider);

const settingsService = createSettingsService({
  store: settingsStore,
  defaultBaseUrl: config.deepseekBaseUrl,
  defaultModel: config.deepseekModel,
});

const app = await buildApp({
  cardService,
  settingsService,
  webDistPath: config.webDistPath,
  logger: true,
});

app.addHook('onClose', async () => {
  repo.close();
});

try {
  await app.listen({ port: config.port, host: config.host });
  const initial = settingsStore.view();
  const modeLabel =
    initial.source === 'mock'
      ? 'mock（未配置 API Key）'
      : `${initial.source === 'user' ? '用户配置' : '环境变量'} (${initial.model})`;
  app.log.info(`摘要模式：${modeLabel}`);
  app.log.info(`数据库：${config.dbPath}`);
  app.log.info(`设置文件：${config.settingsPath}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
