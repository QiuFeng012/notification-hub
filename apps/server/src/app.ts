import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { SummaryError } from './ai/types.js';
import type { CardService } from './services/card-service.js';
import { ValidationError } from './services/card-service.js';

export interface BuildAppOptions {
  cardService: CardService;
  /** 已构建的前端资源目录；不存在就只提供 API */
  webDistPath?: string;
  logger?: boolean;
}

/** 允许的原文长度上限对应的 HTTP 状态：内容过大用 413 更准确 */
const VALIDATION_STATUS: Record<string, number> = {
  INVALID_BODY: 400,
  EMPTY_TEXT: 400,
  INVALID_ID: 400,
  TEXT_TOO_LONG: 413,
};

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 2 * 1024 * 1024,
  });

  // 统一错误出口：把业务异常翻译成稳定的 { error: { code, message } } 结构
  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof ValidationError) {
      return reply
        .code(VALIDATION_STATUS[error.code] ?? 400)
        .send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof SummaryError) {
      return reply.code(502).send({ error: { code: 'SUMMARY_FAILED', message: error.message } });
    }

    // Fastify 自带的解析类错误（如 body 不是合法 JSON）带 4xx statusCode，直接透传
    const fastifyError = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    if (typeof fastifyError.statusCode === 'number' && fastifyError.statusCode < 500) {
      return reply.code(fastifyError.statusCode).send({
        error: {
          code: typeof fastifyError.code === 'string' ? fastifyError.code : 'BAD_REQUEST',
          message: typeof fastifyError.message === 'string' ? fastifyError.message : '请求不合法',
        },
      });
    }

    app.log.error({ err: String(error) }, '未预期的服务端错误');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: '服务端内部错误，请查看服务端日志' } });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/cards', async () => options.cardService.listCards());

  app.post('/api/cards', async (request, reply) => {
    const body = (request.body ?? {}) as { rawText?: unknown };
    const card = await options.cardService.createCard({ rawText: body.rawText });
    return reply.code(201).send(card);
  });

  app.delete('/api/cards/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = options.cardService.deleteCard(id);
    if (!deleted) {
      return reply
        .code(404)
        .send({ error: { code: 'CARD_NOT_FOUND', message: '信息卡不存在或已被删除' } });
    }
    return reply.code(200).send(deleted);
  });

  const webDistPath = options.webDistPath;
  if (webDistPath && fs.existsSync(path.join(webDistPath, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDistPath });
    // SPA 回退：非 /api 的未知路径交回前端路由
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: `接口不存在：${request.url}` } });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}
