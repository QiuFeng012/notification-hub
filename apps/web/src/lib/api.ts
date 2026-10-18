import {
  DEFAULT_HIGHLIGHT_STYLE,
  HEX_COLOR_PATTERN,
  type CardListResponse,
  type CardRevision,
  type CardSchedule,
  type HighlightStyle,
  type InfoCard,
  type ReExtractPreview,
  type SettingsSource,
  type SettingsView,
  type SystemView,
  type UpdateCardRequest,
  type UpdateSettingsRequest,
  type UpdateSettingsResponse,
} from '@notification-hub/shared';
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
  createCard(rawText: string, keywords?: string[]): Promise<CardView>;
  /** 编辑一张卡片；返回更新后的卡片 */
  updateCard(id: string, patch: UpdateCardRequest): Promise<CardView>;
  /**
   * 用一段新原文重新提炼，返回草稿供逐项对比；**不会改动卡片**。
   * 官方改了口径时用它，确认之后再由 updateCard 落库。
   */
  previewReExtract(id: string, rawText: string): Promise<ReExtractPreview>;
  /** 某张卡片的改动历史，最新的在最前 */
  listRevisions(id: string): Promise<CardRevision[]>;
  /** 清空某张卡片的改动历史（内容不动） */
  clearRevisions(id: string): Promise<void>;
  /** 置顶 / 取消置顶；返回更新后的卡片 */
  setPinned(id: string, pinned: boolean): Promise<CardView>;
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

    async createCard(rawText: string, keywords: string[] = []) {
      const payload = (await requestJson('/api/cards', {
        method: 'POST',
        json: keywords.length > 0 ? { rawText, keywords } : { rawText },
      })) as InfoCard;

      const view = toCardView(payload);
      if (!view) {
        throw new ApiError('INVALID_RESPONSE', '服务端返回的信息卡格式不正确', 500);
      }
      return view;
    },

    async updateCard(id: string, patch: UpdateCardRequest) {
      const payload = (await requestJson(`/api/cards/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        json: patch,
      })) as InfoCard;

      const view = toCardView(payload);
      if (!view) {
        throw new ApiError('INVALID_RESPONSE', '服务端返回的信息卡格式不正确', 500);
      }
      return view;
    },

    async previewReExtract(id: string, rawText: string) {
      const payload = (await requestJson(`/api/cards/${encodeURIComponent(id)}/re-extract`, {
        method: 'POST',
        json: { rawText },
      })) as Partial<ReExtractPreview> | null;

      if (!payload || typeof payload.title !== 'string' || !Array.isArray(payload.keyPoints)) {
        throw new ApiError('INVALID_RESPONSE', '服务端返回的提炼结果格式不正确', 500);
      }
      const rawSchedules = Array.isArray(payload.schedules) ? payload.schedules : [];
      return {
        rawText: typeof payload.rawText === 'string' ? payload.rawText : rawText,
        title: payload.title,
        time: typeof payload.time === 'string' && payload.time.length > 0 ? payload.time : null,
        source: typeof payload.source === 'string' && payload.source.length > 0 ? payload.source : null,
        keyPoints: payload.keyPoints.filter((item): item is string => typeof item === 'string'),
        provider: payload.provider === 'deepseek' ? 'deepseek' : 'mock',
        schedule: toScheduleOrNull(payload.schedule),
        // 官方改口径时常常是"报名截止推迟"而活动照旧，拆开列出才看得出动的是哪个
        schedules: rawSchedules
          .map((item) => toScheduleOrNull(item))
          .filter((item): item is CardSchedule => item !== null),
        supplementedKeywords: Array.isArray(payload.supplementedKeywords)
          ? payload.supplementedKeywords.filter((item): item is string => typeof item === 'string')
          : [],
      };
    },

    async listRevisions(id: string) {
      const payload = (await requestJson(`/api/cards/${encodeURIComponent(id)}/revisions`)) as {
        revisions?: unknown;
      } | null;
      const raw = Array.isArray(payload?.revisions) ? payload.revisions : [];
      return raw
        .map((item) => toCardRevision(item))
        .filter((item): item is CardRevision => item !== null);
    },

    async clearRevisions(id: string) {
      await requestJson(`/api/cards/${encodeURIComponent(id)}/revisions`, { method: 'DELETE' });
    },

    async setPinned(id: string, pinned: boolean) {
      const payload = (await requestJson(`/api/cards/${encodeURIComponent(id)}/pinned`, {
        method: 'PUT',
        json: { pinned },
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

/**
 * 归一化服务端返回的排期。字段缺失或类型不对时返回 null
 * （宁可"没有排期"，也不要拿一个半截对象去画日历）。
 */
function toScheduleOrNull(input: unknown): CardSchedule | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  if (typeof record.start !== 'string' || typeof record.end !== 'string') return null;
  return {
    start: record.start,
    end: record.end,
    dayCount: typeof record.dayCount === 'number' ? record.dayCount : 1,
    label: typeof record.label === 'string' ? record.label : '',
    inferredYear: record.inferredYear === true,
  };
}

/** 归一化服务端返回的历史记录，字段缺失或损坏时丢弃该条 */
export function toCardRevision(input: unknown): CardRevision | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  if (typeof record.id !== 'number' || typeof record.cardId !== 'string') return null;

  const reason: CardRevision['reason'] =
    record.reason === 'official' || record.reason === 'manual' ? record.reason : 'other';

  return {
    id: record.id,
    cardId: record.cardId,
    reason,
    note: typeof record.note === 'string' && record.note.length > 0 ? record.note : null,
    previousTitle: typeof record.previousTitle === 'string' ? record.previousTitle : '',
    previousTime: typeof record.previousTime === 'string' ? record.previousTime : null,
    previousSource: typeof record.previousSource === 'string' ? record.previousSource : null,
    previousKeyPoints: Array.isArray(record.previousKeyPoints)
      ? record.previousKeyPoints.filter((item): item is string => typeof item === 'string')
      : [],
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
  };
}

export interface SettingsApi {
  getSettings(): Promise<SettingsView>;
  updateSettings(patch: UpdateSettingsRequest): Promise<UpdateSettingsResponse>;
  /** 清除已保存的配置，回落到环境变量或本地启发式摘要 */
  clearSettings(): Promise<SettingsView>;
}

/** 归一化服务端返回的设置，缺字段时给出安全默认值 */
export function toSettingsView(input: unknown): SettingsView {
  const record = (typeof input === 'object' && input !== null ? input : {}) as Partial<SettingsView>;
  const source: SettingsSource =
    record.source === 'user' || record.source === 'env' || record.source === 'mock' ? record.source : 'mock';
  return {
    configured: record.configured === true,
    apiKeyMask: typeof record.apiKeyMask === 'string' && record.apiKeyMask.length > 0 ? record.apiKeyMask : null,
    source,
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '',
    model: typeof record.model === 'string' ? record.model : '',
    highlight: toHighlightStyle(record.highlight),
  };
}

/** 荧光笔配置的归一化：非法颜色丢弃，缺项补默认值，永不抛错 */
export function toHighlightStyle(input: unknown): HighlightStyle {
  const record = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const toColor = (value: unknown): string | null =>
    typeof value === 'string' && HEX_COLOR_PATTERN.test(value.trim()) ? value.trim().toLowerCase() : null;

  const paletteRaw = Array.isArray(record.multiDayPalette) ? record.multiDayPalette : [];
  const palette = paletteRaw.map((item) => toColor(item)).filter((item): item is string => item !== null);

  const perCard: Record<string, string> = {};
  if (typeof record.perCard === 'object' && record.perCard !== null) {
    for (const [cardId, value] of Object.entries(record.perCard as Record<string, unknown>)) {
      const color = toColor(value);
      if (color) perCard[cardId] = color;
    }
  }

  return {
    singleDay: toColor(record.singleDay) ?? DEFAULT_HIGHLIGHT_STYLE.singleDay,
    multiDayPalette: palette.length > 0 ? palette : [...DEFAULT_HIGHLIGHT_STYLE.multiDayPalette],
    perCard,
  };
}

export function createSettingsApi(): SettingsApi {
  return {
    async getSettings() {
      return toSettingsView(await requestJson('/api/settings'));
    },

    async updateSettings(patch) {
      const payload = (await requestJson('/api/settings', {
        method: 'PUT',
        json: patch,
      })) as Partial<UpdateSettingsResponse> | null;

      return {
        settings: toSettingsView(payload?.settings),
        warning: typeof payload?.warning === 'string' && payload.warning.length > 0 ? payload.warning : null,
      };
    },

    async clearSettings() {
      return toSettingsView(await requestJson('/api/settings', { method: 'DELETE' }));
    },
  };
}

export interface SystemApi {
  getSystem(): Promise<SystemView>;
  setAutostart(enabled: boolean): Promise<SystemView>;
  shutdown(): Promise<void>;
  uninstall(): Promise<void>;
}

/** 归一化服务端返回的系统状态，缺字段时给安全默认值（绝不抛错） */
export function toSystemView(input: unknown): SystemView {
  const record = (typeof input === 'object' && input !== null ? input : {}) as Partial<SystemView>;
  return {
    autostart: record.autostart === true,
    port: typeof record.port === 'number' && Number.isInteger(record.port) ? record.port : 5178,
    dataDir: typeof record.dataDir === 'string' ? record.dataDir : '',
  };
}

export function createSystemApi(): SystemApi {
  return {
    async getSystem() {
      return toSystemView(await requestJson('/api/system'));
    },

    async setAutostart(enabled: boolean) {
      return toSystemView(
        await requestJson('/api/system/autostart', { method: 'POST', json: { enabled } }),
      );
    },

    async shutdown() {
      await requestJson('/api/system/shutdown', { method: 'POST' });
    },

    async uninstall() {
      await requestJson('/api/system/uninstall', { method: 'POST' });
    },
  };
}
