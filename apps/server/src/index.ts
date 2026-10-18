import path from 'node:path';
import { createSummarizerProvider } from './ai/provider.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createSqliteCardRepository } from './db/sqlite-repository.js';
import { createCardService } from './services/card-service.js';
import { createSettingsService } from './services/settings-service.js';
import { createSystemService } from './services/system-service.js';
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

// 生命周期：关闭、开机自启、卸载
const systemService = createSystemService({
  repoRoot: config.repoRoot,
  port: config.port,
  dataDir: path.dirname(config.dbPath),
});

// 关闭与卸载都要先把响应发出去、再关服务；先关服务客户端会拿不到响应。
let app!: Awaited<ReturnType<typeof buildApp>>;
function scheduleClose(): void {
  setTimeout(() => {
    // 兜底：万一 close 被残留连接拖住，最多等 3 秒也强制退出
    const fallback = setTimeout(() => process.exit(0), 3000);
    void app.close().then(
      () => {
        clearTimeout(fallback);
        process.exit(0);
      },
      (error: unknown) => {
        clearTimeout(fallback);
        app.log.error(error);
        process.exit(1);
      },
    );
  }, 50);
}

app = await buildApp({
  cardService,
  settingsService,
  systemService,
  webDistPath: config.webDistPath,
  logger: true,
  onShutdown: scheduleClose,
  onUninstall: scheduleClose,
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
