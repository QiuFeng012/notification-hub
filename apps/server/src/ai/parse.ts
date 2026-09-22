import {
  MAX_KEY_POINTS,
  MAX_KEY_POINT_LENGTH,
  MAX_TITLE_LENGTH,
  SummaryError,
  type CardDraft,
} from './types.js';

/** 一份"空但有解释"的草稿，比抛错更让用户明白发生了什么 */
function fallbackDraft(rawText: string, reason: string): CardDraft {
  const firstLine = rawText.split('\n').find((line) => line.trim().length > 0)?.trim() ?? rawText.trim();
  return {
    title: truncate(firstLine, MAX_TITLE_LENGTH) || '未能识别的通知',
    time: null,
    source: null,
    keyPoints: [reason],
  };
}

export function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

/**
 * 容错把模型返回值规整成 CardDraft。
 *
 * 模型不可信：字段可能缺失、类型不对、要点可能是字符串而非数组。
 * 这里不抛异常，能救就救，救不回来才由调用方决定如何处理。
 */
export function coerceDraft(candidate: unknown): CardDraft | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const record = candidate as Record<string, unknown>;

  const rawTitle = typeof record.title === 'string' ? record.title.trim() : '';
  const rawKeyPoints = Array.isArray(record.key_points)
    ? record.key_points
    : typeof record.key_points === 'string'
      ? record.key_points.split('\n')
      : [];

  const keyPoints = rawKeyPoints
    .filter((item): item is string => typeof item === 'string')
    .map((item) => truncate(item, MAX_KEY_POINT_LENGTH))
    .filter((item) => item.length > 0)
    .slice(0, MAX_KEY_POINTS);

  if (keyPoints.length === 0) return null;

  return {
    title: truncate(rawTitle, MAX_TITLE_LENGTH) || truncate(keyPoints[0] ?? '', MAX_TITLE_LENGTH),
    time: normalizeOptionalString(record.time, 64),
    source: normalizeOptionalString(record.source, 64),
    keyPoints,
  };
}

function normalizeOptionalString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = truncate(value, max);
  if (trimmed.length === 0) return null;
  // 模型偶尔会输出 "null" / "未知" / "N/A" 这类占位文本，统一当作没识别出来
  if (/^(null|none|n\/a|na|unknown|未知|无|不详)$/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * 从模型返回的文本中抠出 JSON 对象。
 *
 * 即使开了 response_format=json_object，也仍要兜底：模型可能包裹 ```json 代码块，
 * 或在 JSON 前后附加解释性文字。这里先直接解析，失败再退化为"取第一个花括号块"。
 */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new SummaryError('模型返回了空内容');
  }

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const parsed = tryParse(trimmed.slice(start, end + 1));
    if (parsed !== undefined) return parsed;
  }

  throw new SummaryError('模型返回的内容不是合法 JSON');
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 把模型输出解析成 CardDraft；解析不出来就退化成"单条说明"草稿 */
export function parseSummaryResponse(text: string, rawText: string): CardDraft {
  try {
    const draft = coerceDraft(extractJsonObject(text));
    if (draft) return draft;
    return fallbackDraft(rawText, '模型返回的 JSON 缺少有效要点，请检查原文是否包含可总结的信息');
  } catch (error) {
    const reason = error instanceof SummaryError ? error.message : '模型输出解析失败';
    return fallbackDraft(rawText, `${reason}，本条要点为系统占位提示`);
  }
}
