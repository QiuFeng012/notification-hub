import { createSummarizer } from './ai/index.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createSqliteCardRepository } from './db/sqlite-repository.js';
import { createCardService } from './services/card-service.js';

const config = loadConfig();
const repo = createSqliteCardRepository(config.dbPath);
const summarizer = createSummarizer({
  apiKey: config.deepseekApiKey,
  baseUrl: config.deepseekBaseUrl,
  model: config.deepseekModel,
  timeoutMs: config.aiTimeoutMs,
});
const cardService = createCardService(repo, summarizer);

const app = await buildApp({
  cardService,
  webDistPath: config.webDistPath,
  logger: true,
});

app.addHook('onClose', async () => {
  repo.close();
});

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`摘要模式：${config.deepseekApiKey ? `DeepSeek (${config.deepseekModel})` : 'mock（未配置 DEEPSEEK_API_KEY）'}`);
  app.log.info(`数据库：${config.dbPath}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
