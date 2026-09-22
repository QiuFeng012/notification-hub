import type { CardListResponse, InfoCard } from '@notification-hub/shared';
import { toCardView, type CardView } from './card-view';

/**
 * 携带服务端错误码的异常，便于界面区分"内容为空"和"服务端故障"。
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function requestJson(path: string, init?: RequestInit & { json?: unknown }): Promise<unknown> {
  const { json, ...rest } = init ?? {};
  // 只有真正带 body 的请求才声明 Content-Type：
  // 给无 body 的 DELETE 加 application/json 会让服务端 JSON 解析器以
  // FST_ERR_CTP_EMPTY_JSON_BODY 直接拒绝，请求根本到不了业务逻辑。
  const headers: Record<string, string> = { ...((rest.headers as Record<string, string>) ?? {}) };
  if (json !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(path, {
      ...rest,
      headers,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', '无法连接到本地服务，请确认服务端已启动', 0);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const errorBody = payload as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(
      errorBody?.error?.code ?? 'HTTP_ERROR',
      errorBody?.error?.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
    );
  }

  return payload;
}

export interface CardApi {
  listCards(): Promise<CardView[]>;
  createCard(rawText: string): Promise<CardView>;
  deleteCard(id: string): Promise<void>;
}

export function createCardApi(): CardApi {
  return {
    async listCards() {
      const payload = (await requestJson('/api/cards')) as Partial<CardListResponse> | null;
      const rawCards = Array.isArray(payload?.cards) ? payload.cards : [];
      return rawCards
        .map((card) => toCardView(card))
        .filter((card): card is CardView => card !== null);
    },

    async createCard(rawText: string) {
      const payload = (await requestJson('/api/cards', {
        method: 'POST',
        json: { rawText },
      })) as InfoCard;

      const view = toCardView(payload);
      if (!view) {
        throw new ApiError('INVALID_RESPONSE', '服务端返回的信息卡格式不正确', 500);
      }
      return view;
    },

    async deleteCard(id: string) {
      await requestJson(`/api/cards/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  };
}
